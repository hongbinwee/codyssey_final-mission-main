// F07 복귀 보존 — 상세→전체 리뷰→뒤로 이동은 라우트 전환 리마운트로 선택
// 옵션·수량·스크롤이 초기화되는 회귀가 있었다. 전체 리뷰로 나갈 때만
// (계정, 상품) 스냅샷을 보관하고, 복귀 시 같은 계정·같은 상품에서 한 번
// 복원 후 즉시 소비한다 — 다른 상품·계정·진입 경로에는 적용하지 않는다.
// 복원 불가(품절·재고 감소)는 조용한 교체가 아니라 notice로 알려 사용자가
// 재확인하게 한다 [PM 읽기 검토 지적 2건, PMQA-066 Project].
export type DetailResume = {
  user: string | null;
  variantId: string | null;
  qty: number;
  scrollY: number;
};

const store = new Map<string, DetailResume>();

// 전체 리뷰 진입 직전 스냅샷을 남긴다 — 상세 화면을 떠나는 시점의 상태다.
export function saveDetailResume(productId: string, entry: DetailResume): void {
  store.set(productId, entry);
}

// 복원 후보를 꺼낸다 — 조회 즉시 소비(1회성)라 재진입·다른 경로에는 남지 않는다.
export function takeDetailResume(productId: string): DetailResume | undefined {
  const r = store.get(productId);
  if (r) store.delete(productId);
  return r;
}

// loadInitial 전용 소비 경로 — isStale()(언마운트·세대 갱신)이면 스냅샷을
// 소비하지 않고 undefined를 돌려준다. 화면 밖의 늦은 응답이 복원 데이터를
// 삼키는 회귀를 막는다 [Luna PMQA-066 읽기 검토].
export function takeDetailResumeIfFresh(
  isStale: () => boolean,
  productId: string,
): DetailResume | undefined {
  if (isStale()) return undefined;
  return takeDetailResume(productId);
}

export type ResumeNotice = "OPTION_UNAVAILABLE" | "QTY_REDUCED";
export type InitialVariant = { variantId: string | null; unavailable: boolean };

// Explicit product links select that exact available option; ordinary links
// retain the existing first-available default. An invalid explicit target has
// no selection so the caller can ask the user to choose again.
export function resolveInitialVariant(
  variants: { variant_id: string; availability: string }[],
  requestedVariantId?: string,
): InitialVariant {
  const selected = requestedVariantId === undefined
    ? variants.find((v) => v.availability === "AVAILABLE")
    : variants.find((v) => v.variant_id === requestedVariantId && v.availability === "AVAILABLE");
  return {
    variantId: selected?.variant_id ?? null,
    unavailable: requestedVariantId !== undefined && !selected,
  };
}

export type ResumePlan = {
  // true면 스냅샷을 적용 — variantId/qty/scrollY를 화면에 반영한다.
  apply: boolean;
  // 복원할 옵션 id — null이면 호출부가 기본 선택 규칙을 적용한다.
  variantId: string | null;
  qty: number;
  scrollY: number;
  // 복원을 못해 값이 바뀐 경우 — 조용히 교체하지 않고 사용자 안내를 요한다.
  notice: ResumeNotice | null;
};

// 저장 스냅샷을 현재 variants와 대조해 복원 계획을 만든다.
export function resolveDetailResume(
  variants: {
    variant_id: string;
    availability: string;
    stock_qty: number;
  }[],
  resume: DetailResume | undefined,
  userId: string | null,
): ResumePlan {
  // 스냅샷 없음/다른 계정 — 기본 초기화 경로로 간다(타인 상태를 노출하지 않는다).
  if (!resume || resume.user !== userId)
    return { apply: false, variantId: null, qty: 1, scrollY: 0, notice: null };
  const keep = resume.variantId
    ? variants.find(
        (v) =>
          v.variant_id === resume.variantId && v.availability === "AVAILABLE",
      )
    : undefined;
  if (!keep)
    // 저장 옵션이 품절·삭제됐다 — 기본 옵션으로 조용히 바꾸지 않고 안내한다.
    return {
      apply: true,
      variantId: null,
      qty: 1,
      scrollY: resume.scrollY,
      notice: "OPTION_UNAVAILABLE",
    };
  const qty = Math.min(Math.max(1, resume.qty), Math.max(1, keep.stock_qty));
  return {
    apply: true,
    variantId: keep.variant_id,
    qty,
    scrollY: resume.scrollY,
    notice: qty < resume.qty ? "QTY_REDUCED" : null,
  };
}
