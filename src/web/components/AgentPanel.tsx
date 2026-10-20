// A01 공통 AI 대화·비교 패널
import { useEffect, useRef, useState } from "react";
import { BrainPreview } from "./BrainPreview.tsx";
import { apiSafe, fmtWon, newActionKey, type AgentBrain } from "../api.ts";
import type { CompareCard } from "../../contracts.ts";
import { AGENT_TURN_ENABLED, sendAgentTurn } from "../agent-gate.ts";

export interface AgentReply {
  role: "user" | "ai";
  text: string;
  evidence?: { products: string[]; variants: string[]; reviews: string[] };
  compare?: CompareCard;
  toolCalls?: string[];
  error?: boolean;
}

// 카트에 영향을 주는 쓰기 Tool — 성공 시 헤더 카트를 갱신한다.
const CART_WRITE_TOOLS = ["add_to_cart", "update_cart_quantity", "remove_cart_item"];

function CompareCardView({
  card,
  onOpenProduct,
}: {
  card: CompareCard;
  onOpenProduct: (id: string) => void;
}) {
  return (
    <div className="compare-card">
      {card.products.map((p) => (
        <div key={p.product_id} className="compare-row">
          <div className="compare-head">
            <b>{p.name}</b>
            {(p.rating_summary.avg === null || p.rating_summary.avg <= 3.5 || p.rating_summary.count < 10) && (
              <span className="chip">참고용 상품 · 평점/저장 리뷰 기준 미충족</span>
            )}
            {p.availability !== "AVAILABLE" && <span className="badge-soldout">품절/중단</span>}
          </div>
          <div className="muted sm">
            {fmtWon(p.min_price_won)}
            {p.max_price_won > p.min_price_won && " ~ " + fmtWon(p.max_price_won)}
            {" · "}
            {p.rating_summary.avg === null
              ? "평점 없음"
              : "★" + p.rating_summary.avg}
            {" · 저장된 리뷰 " + p.rating_summary.count + "개"}
          </div>
          <div className="muted sm">
            조회·비교용 · 저장된 리뷰 수는 Amazon 전체 리뷰 수가 아니에요
          </div>
          <div className="muted sm">
            근거 리뷰:{" "}
            {p.evidence_review_ids.length > 0
              ? p.evidence_review_ids.join(", ")
              : "없음"}
          </div>
          <button className="link" onClick={() => onOpenProduct(p.product_id)}>
            상품 보기
          </button>
        </div>
      ))}
      {card.limitations.length > 0 && (
        <div className="muted sm compare-limit">
          {card.limitations.map((l) => (
            <div key={l}>· {l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentPanel({
  brain,
  messages,
  setMessages,
  pageContext,
  onOpenProduct,
  onOpenCart,
  onOpenCheckout,
  onOpenOrders,
  onOpenOrder,
  checkoutEnabled,
  onCartChanged,
  onClose,
}: {
  brain: AgentBrain;
  messages: AgentReply[];
  setMessages: (m: AgentReply[]) => void;
  pageContext: { screen?: string; product_id?: string; order_id?: string };
  onOpenProduct: (id: string, variantId?: string) => void;
  onOpenCart: () => void;
  onOpenCheckout: () => void;
  onOpenOrders: () => void;
  onOpenOrder: (orderId: string) => void;
  checkoutEnabled: boolean;
  onCartChanged: () => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const supported = AGENT_TURN_ENABLED && brain === "shopping";
  const [useBrainPreview,setUseBrainPreview]=useState(false);
  useEffect(()=>{
    let mounted=true;
    if(brain==="shopping"){
      void apiSafe<{enabled:boolean}>("/api/brain/status").then(r=>{
        if(mounted&&r.ok&&r.data.enabled)setUseBrainPreview(true);
      });
    }
    return ()=>{mounted=false;};
  },[brain]);


  async function send() {
    const text = input.trim();
    if (!text || inFlight.current || !supported) return;
    inFlight.current = true;
    setInput("");
    setBusy(true);
    const next = [...messages, { role: "user" as const, text }];
    setMessages(next);
    try {
      const r = await sendAgentTurn<{
        message: string;
        evidence_refs: { products: string[]; variants: string[]; reviews: string[] };
        compare?: CompareCard;
        tool_calls: { name: string; ok: boolean; code?: string }[];
        limit_reached?: boolean;
        error?: string;
      }>(
        {
          user_message: text,
          page_context: pageContext,
          client_action_id: newActionKey(),
          brain,
        },
        (path, body) =>
          apiSafe(path, { method: "POST", body: JSON.stringify(body) }),
      );
      if (!r.ok) {
        setMessages([...next, { role: "ai", text: "AI 응답을 받지 못했어요. 잠시 후 다시 보내 주세요.", error: true }]);
        setInput(text);
        return;
      }
      const d = r.data;
      if (d.tool_calls.some((c) => c.ok && CART_WRITE_TOOLS.includes(c.name))) onCartChanged();
      setMessages([
        ...next,
        {
          role: "ai",
          text: d.error || d.limit_reached
            ? "조회를 완료하지 못했어요. 조건을 줄여 다시 보내 주세요."
            : d.message,
          evidence: d.evidence_refs,
          compare: d.compare,
          toolCalls: d.tool_calls.map((c) => c.name + (c.ok ? "" : "✗")),
          error: !!d.error || !!d.limit_reached,
        },
      ]);
    } catch {
      setMessages([...next, { role: "ai", text: "AI 응답을 받지 못했어요. 잠시 후 다시 보내 주세요.", error: true }]);
      setInput(text);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if(useBrainPreview&&brain==="shopping")
    return <BrainPreview onOpenProduct={onOpenProduct} onClose={onClose}
      onOpenCart={onOpenCart} onOpenCheckout={onOpenCheckout} onOpenOrders={onOpenOrders}
      onOpenOrder={onOpenOrder} checkoutEnabled={checkoutEnabled}/>;

  return (
    <aside className="agent-panel">
      <div className="agent-head">
        <div>
          <b>{brain === "cs" ? "AI 고객센터" : "AI 쇼핑 도우미"}</b>
          <div className="muted sm">
            {supported ? "AI 생성 답변 · 실제 상품과 저장된 리뷰를 조회합니다" : "AI 고객센터는 아직 지원하지 않아요"}
          </div>
        </div>
        <button className="link" onClick={onClose} disabled={busy}>닫기</button>
      </div>
      <div className="agent-body">
        {messages.length === 0 && (
          <div className="state-box">
            {!supported
              ? "이 AI 기능은 아직 지원하지 않아요"
              : "예산·용도를 알려주세요. 예: “배송비 포함 20만원 안에서 개발용 모니터 비교해줘”"}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + m.role + (m.error ? " err" : "")}>
            <p>{m.text}</p>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div className="muted sm">Tool: {m.toolCalls.join(", ")}</div>
            )}
            {m.compare && (
              <CompareCardView card={m.compare} onOpenProduct={onOpenProduct} />
            )}
            {m.evidence && (m.evidence.products.length + m.evidence.reviews.length > 0) && (
              <div className="evidence-chips">
                {m.evidence.products.map((id) => (
                  <button key={id} className="chip link-chip" onClick={() => onOpenProduct(id)}>
                    상품 보기 · {id}
                  </button>
                ))}
                {m.evidence.reviews.map((id) => (
                  <span key={id} className="chip">리뷰 {id}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg ai" role="status" aria-live="polite">
            <p>실제 상품과 리뷰를 비교하고 있어요. 응답에 시간이 걸릴 수 있어요</p>
          </div>
        )}
      </div>
      <div className="agent-input">
        <input
          value={input}
          disabled={busy || !supported}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send()}
          placeholder="조건이나 요청을 입력하세요"
        />
        <button className="btn primary" onClick={send} disabled={busy || !supported || !input.trim()}>
          보내기
        </button>
      </div>
    </aside>
  );
}
