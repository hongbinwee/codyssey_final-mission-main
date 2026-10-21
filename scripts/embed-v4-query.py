#!/usr/bin/env python3
"""Line-oriented CPU query encoder for the immutable v4 evidence vectors."""

import json
import os
import re
import sys

MODEL_ID = os.environ.get("CODEX_RAG_MODEL_ID", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
DIMENSIONS = int(os.environ.get("CODEX_RAG_DIMENSIONS", "384"))


def main() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")

    revision = os.environ.get("CODEX_V4_MODEL_REVISION", "")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError("CODEX_V4_MODEL_REVISION must be the downloaded 40-character model commit")
    if not re.fullmatch(r"[-\w.]+/[-\w.]+", MODEL_ID) or not 1 <= DIMENSIONS <= 4096:
        raise RuntimeError("invalid query encoder model or dimensions")

    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(
        MODEL_ID,
        revision=revision,
        device="cpu",
        local_files_only=True,
    )
    actual_dimensions = model.get_sentence_embedding_dimension()
    if actual_dimensions != DIMENSIONS:
        raise RuntimeError(
            f"{MODEL_ID}@{revision} returned {actual_dimensions} dimensions; expected {DIMENSIONS}"
        )

    for line_number, line in enumerate(sys.stdin, start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
            query = payload.get("query") if isinstance(payload, dict) else None
            if not isinstance(query, str) or not query.strip():
                raise ValueError("input must be a JSON object with a non-empty query string")
            vector = model.encode(query, convert_to_numpy=True, normalize_embeddings=False)
            embedding = vector.tolist()
            if len(embedding) != DIMENSIONS:
                raise RuntimeError(f"encoder returned {len(embedding)} dimensions; expected {DIMENSIONS}")
            response = {
                "model": MODEL_ID,
                "revision": revision,
                "dimensions": DIMENSIONS,
                "embedding": embedding,
            }
        except Exception as error:  # Keep stdout machine-readable for each input line.
            response = {"error": f"line {line_number}: {error}"}
        print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"embed-v4-query: {error}", file=sys.stderr)
        raise SystemExit(1)
