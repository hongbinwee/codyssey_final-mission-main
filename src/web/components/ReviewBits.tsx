// 리뷰 공용 표시 — 상세 인라인 요약과 전체 리뷰 전용 화면이 같은
// 행·클러스터를 쓴다 [Ref19/20]. 사진·작성자·도움됨은 미지원 데이터라
// 여기서도 만들지 않는다.
import { IcStar } from "../icons.tsx";
import type { ReviewItem } from "../../contracts.ts";

// 큰 별 5개 묶음 — 채워진 수는 반올림. aria는 실제 평점을 그대로 전달한다.
export function Stars({ rating, size = 18 }: { rating: number; size?: number }) {
  const n = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className="stars" aria-label={"별점 " + rating + "점"}>
      {[1, 2, 3, 4, 5].map((i) => (
        <IcStar key={i} size={size} className={i <= n ? "star-on" : "star-off"} />
      ))}
    </span>
  );
}

// flat 리뷰 행 + divider — variant id가 아니라 옵션 라벨을 표시한다.
export function ReviewRow({
  rv,
  optionLabel,
  dateText,
}: {
  rv: ReviewItem;
  optionLabel: string | null;
  dateText: string;
}) {
  return (
    <li className="review-item">
      <div className="review-head">
        <b aria-label={"별점 " + rv.rating + "점"}>{"★".repeat(rv.rating)}</b>
        <span
          className={
            "src-chip" + (rv.source_kind === "SYNTHETIC" ? " syn" : "")
          }
        >
          {rv.source_kind === "SYNTHETIC" ? "시연 리뷰" : "수집 리뷰"}
        </span>
        <time className="review-date" dateTime={rv.written_at}>
          {dateText}
        </time>
      </div>
      {optionLabel && <div className="review-option muted">옵션 {optionLabel}</div>}
      <p>{rv.body}</p>
    </li>
  );
}
