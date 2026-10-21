// 찜 서비스 — 화면 API와 명시적 요청을 검증한 Hermes V2 Tool이 공유한다.
// SET_WISHLIST는 기존 runAction 계약을 최소 재사용한다 [PMQA-070]:
// saved+PK만으로는 재전송 간 다른 의도(저장↔해제)를 구분할 수 없으므로,
// action_requests의 kind+idempotency_key+payload_hash 기록으로
//   · 같은 키의 반대 saved 충돌 → IDEMPOTENCY_CONFLICT
//   · 같은 키+같은 payload 재전송 → 저장 결과 replay
//   · 응답 유실 → OUTCOME_UNKNOWN + getActionResult 복구
// 를 카트/결제/취소와 같은 방식으로 처리한다.
//
// 입력 검증은 runAction '이전'에 끝낸다 — invalid payload가 action_requests
// 에 기록되면, 이후 정상 요청의 pending 조회가 과거 행의 saved를 해석할 때
// 비정형 값을 만나 영구 실패할 수 있다(사전 검수). 유효 payload만 기록된다.
//
// 동시성 근거(사전 정적 검수 추가 조건):
// - actor 직렬화는 users 행의 FOR NO KEY UPDATE다. 이 트랜잭션은 이미
//   action_requests INSERT로 users에 FOR KEY SHARE를 쥐고 있고(FK 참조),
//   같은 actor의 두 요청이 각각 KEY SHARE를 든 채 FOR UPDATE로 승격하면
//   상호 대기 데드락이다. FOR NO KEY UPDATE는 KEY SHARE와 충돌하지 않으면서
//   같은 actor의 write를 직렬화하고, users 일반 UPDATE(NO KEY UPDATE)와도
//   직렬화된다 — PK를 바꾸지 않는 잠금이라 가장 약한 충분한 강도다.
// - 상품 active 판정은 대상 products 행의 FOR SHARE다. 일반 UPDATE가 잡는
//   NO KEY UPDATE와 실제로 충돌하는 잠금이라 active 동시 변경이 있으면
//   그 커밋을 기다린 뒤 최신 값으로 판정한다(후판정). FOR KEY SHARE는
//   NO KEY UPDATE와 충돌하지 않으므로 'active 갱신을 막았다'고 주장할 수
//   없어 사용하지 않는다.
// - 같은 상품의 status='READY' SET_WISHLIST는 FOR UPDATE로 소유 트랜잭션
//   종료까지 기다린다 — 락 획득 후 READY가 남는 것은 방어적 확인이며,
//   반대 saved의 새 키 실행은 OPERATION_IN_FLIGHT로 거절한다(결과 불명 중
//   반대 상태 기록 방지). READY 행만 읽으므로 과거 REJECTED/SUCCEEDED
//   기록을 건드리지 않고, saved 비교는 ::boolean 캐스트 없이 텍스트로
//   해 과거 비정형 payload에 안전하다.
// - 판매 중단(active=false) 상품의 새 저장(saved=true)은 거절한다.
//   기존 저장은 그대로 보존하고 해제(saved=false)는 항상 허용한다.
//   품절은 찜 가능하다(재고와 무관한 표시 의사다).
// - 물리 삭제는 wishlist_items FK(NO ACTION)가 거절하므로 목록의 join은
//   항상 성립한다 — 비활성 상품도 '판매 중단' 표시로 보존·해제 가능하다.
// - GET 읽기는 변경 0 — 잠금·쓰기 없이 목록만 반환한다.
import { sql, type Q } from "./db.ts";
import { ok, fail, err, type ToolResult, type ToolError } from "./contracts.ts";
import type { WishlistView, SetWishlistResult } from "./contracts.ts";
import { runAction, type ActionResult, type SqlDb } from "./actions.ts";
import type { RequestContext } from "./session.ts";

// PUT body strict 검증 — 순수 함수라 DB-free로 검증된다.
// null/array body·saved 비boolean·idempotency_key 비문자열/공백/과대값은
// 거절한다. actor 주장 필드(user_id 등)는 읽지 않는다 — 실행 주체는
// 세션 토큰뿐이다(기존 cart/checkout과 동일 계약).
export function parseWishlistPut(
  body: unknown,
):
  | { ok: true; saved: boolean; idempotency_key: string }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, error: "요청 형식이 올바르지 않습니다" };
  const b = body as Record<string, unknown>;
  if (typeof b.saved !== "boolean")
    return { ok: false, error: "saved는 boolean이어야 합니다" };
  const k = b.idempotency_key;
  if (typeof k !== "string" || !k.trim() || k.length > 200)
    return {
      ok: false,
      error: "idempotency_key가 필요합니다(비어있지 않은 문자열)",
    };
  return { ok: true, saved: b.saved, idempotency_key: k };
}

// setWishlist 입력 검증 — invalid payload는 runAction 이전에 거절해
// action_requests에 기록하지 않는다(no-write).
export function setWishlistInputError(input: unknown): ToolError | null {
  const i = input as { product_id?: unknown; saved?: unknown } | null;
  if (!i || typeof i.product_id !== "string" || !i.product_id.trim())
    return err("VALIDATION", "product_id가 필요합니다");
  if (typeof i.saved !== "boolean")
    return err("VALIDATION", "saved는 boolean이어야 합니다");
  return null;
}

// 세션 actor의 목록만 조회한다 — 입력의 user_id 같은 필드는 허용하지 않는다.
// 비활성 상품도 표시 정보와 함께 보존한다(active=false → '판매 중단' 표시,
// 해제는 항상 가능).
export async function getWishlist(
  ctx: RequestContext,
  db: Q = sql,
): Promise<ToolResult<WishlistView>> {
  const trace_id = crypto.randomUUID();
  const rows = await db.unsafe<
    {
      product_id: string;
      created_at: string | Date;
      name: string;
      image_urls: string[] | null;
      active: boolean;
      min_price_won: number | null;
    }[]
  >(
    "SELECT w.product_id, w.created_at, p.name, p.image_urls, p.active, " +
      // 최저가는 판매 가능한 활성 variant만 집계 — catalog 목록·상세의 active=true
      // 계약과 정합 [MAJOR070-PRICE]. 비활성 옵션이 더 저렴해도 찜 가격에 섞지 않고,
      // 활성 옵션이 0개면 null(가격 미확인)을 반환해 카드가 가격을 표시하지 않는다.
      "(SELECT min(v.unit_price_won) FROM product_variants v WHERE v.product_id = p.id AND v.active = true) AS min_price_won " +
      "FROM wishlist_items w JOIN products p ON p.id = w.product_id " +
      "WHERE w.user_id=$1 ORDER BY w.created_at DESC, w.product_id ASC",
    [ctx.actorUserId],
  );
  return ok(
    {
      items: rows.map((r) => ({
        product_id: r.product_id,
        saved_at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
        name: r.name,
        image: r.image_urls?.[0] ?? null,
        active: r.active,
        min_price_won: r.min_price_won,
      })),
    },
    trace_id,
  );
}

export type SetWishlistInput = {
  product_id: string;
  saved: boolean;
};

// ctx 세션 주체의 찜만 변경한다.
export async function setWishlist(
  input: SetWishlistInput,
  ctx: RequestContext,
  idempotencyKey: string,
  db: SqlDb = sql,
): Promise<ActionResult<SetWishlistResult>> {
  // invalid payload는 runAction 이전에 거절 — action_requests에 비정형
  // payload를 기록하지 않는다(기록 0, no-write).
  const bad = setWishlistInputError(input);
  if (bad)
    return {
      ok: false as const,
      error: bad,
      trace_id: crypto.randomUUID(),
    };

  return runAction(ctx, "SET_WISHLIST", idempotencyKey, input, async (q) => {
    const trace_id = crypto.randomUUID();

    // actor 직렬화 — users 행의 FOR NO KEY UPDATE. 같은 actor의 SET_WISHLIST를
    // 직렬화하면서 action_requests/wishlist_items FK의 KEY SHARE와 충돌하지
    // 않는다(FOR UPDATE를 쓰면 같은 actor 동시 요청끼리 데드락).
    const users = await q.unsafe<{ id: string }[]>(
      "SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE",
      [ctx.actorUserId],
    );
    if (!users[0])
      return fail(err("NOT_FOUND", "사용자를 찾을 수 없습니다"), trace_id);

    // 같은 상품의 'READY' SET_WISHLIST만 잠근다 — 소유 트랜잭션 종료를 기다려
    // 반대 saved의 새 키 실행을 막는다. 과거 확정 행은 건드리지 않고, saved
    // 비교는 텍스트로 해 비정형 payload에도 SQL이 실패하지 않는다.
    const pendings = await q.unsafe<
      { id: string; payload_saved: string | null }[]
    >(
      "SELECT id, payload_json->>'saved' AS payload_saved FROM action_requests " +
        "WHERE actor_user_id=$1 AND kind='SET_WISHLIST' AND status='READY' " +
        "AND payload_json->>'product_id'=$2 AND idempotency_key<>$3 FOR UPDATE",
      [ctx.actorUserId, input.product_id, idempotencyKey],
    );
    if (
      pendings.some(
        (r) => r.payload_saved !== null && r.payload_saved !== String(input.saved),
      )
    )
      return fail(
        err(
          "OPERATION_IN_FLIGHT",
          "이 상품의 이전 찜 요청 결과를 확인 중입니다. 확인 후 다시 시도하세요.",
          "CHECK_OPERATION",
        ),
        trace_id,
      );

    // 상품 active 후판정 — FOR SHARE는 active를 바꾸는 일반 UPDATE
    // (NO KEY UPDATE)와 충돌해 그 커밋을 기다린 뒤 최신 값을 읽는다.
    const prods = await q.unsafe<{ id: string; active: boolean }[]>(
      "SELECT id, active FROM products WHERE id=$1 FOR SHARE",
      [input.product_id],
    );
    const prod = prods[0];
    if (!prod)
      return fail(err("NOT_FOUND", "상품을 찾을 수 없습니다"), trace_id);
    if (input.saved && !prod.active)
      return fail(
        err("UNAVAILABLE", "판매 중단 상품은 찜할 수 없어요"),
        trace_id,
      );

    if (input.saved) {
      await q.unsafe(
        "INSERT INTO wishlist_items (user_id, product_id) VALUES ($1,$2) " +
          "ON CONFLICT (user_id, product_id) DO NOTHING",
        [ctx.actorUserId, input.product_id],
      );
    } else {
      await q.unsafe(
        "DELETE FROM wishlist_items WHERE user_id=$1 AND product_id=$2",
        [ctx.actorUserId, input.product_id],
      );
    }
    const [cnt] = await q.unsafe<{ n: number }[]>(
      "SELECT count(*)::int AS n FROM wishlist_items WHERE user_id=$1",
      [ctx.actorUserId],
    );
    return ok(
      {
        product_id: input.product_id,
        saved: input.saved,
        wishlist_count: cnt?.n ?? 0,
      },
      trace_id,
    );
  }, db);
}
