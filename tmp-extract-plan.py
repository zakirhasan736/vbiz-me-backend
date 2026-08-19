import json

path = r"C:\Users\zakir\.cursor\projects\c-Users-zakir-Desktop-vbiz-me-administration\agent-transcripts\2427107d-ae61-4a7c-b19f-7fc6d7a2b6af\2427107d-ae61-4a7c-b19f-7fc6d7a2b6af.jsonl"
needles = [
    "Remaining work",
    "13. Build",
    "per-Corporate",
    "Payment Link",
    "IMPLEMENTATION PLAN",
    "Gaps still",
    "signup fee",
]

found = 0
chunks = []
with open(path, encoding="utf-8") as f:
    for i, line in enumerate(f, 1):
        try:
            obj = json.loads(line)
        except Exception:
            continue
        role = obj.get("role")
        content = obj.get("message", {}).get("content", [])
        texts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                texts.append(c.get("text", ""))
            elif isinstance(c, dict) and "text" in c:
                texts.append(c.get("text", ""))
        text = "\n".join(texts)
        if role == "user" and i in (3583, 3584) and "signup" in text.lower():
            chunks.append(f"=== USER LINE {i} len {len(text)} ===\n")
            for key in ["SIGNUP", "signup", "Payment Link", "Corporate", "IMPLEMENTATION"]:
                idx = text.find(key)
                if idx >= 0:
                    chunks.append(f"--- user {key} at {idx} ---\n")
                    chunks.append(text[idx : idx + 1800] + "\n\n")
            continue
        if role != "assistant":
            continue
        if not any(n in text for n in needles):
            continue
        if "IMPLEMENTATION PLAN" not in text and "Remaining work" not in text and "13. Build" not in text:
            continue
        chunks.append(f"=== LINE {i} len {len(text)} ===\n")
        for key in needles:
            idx = text.find(key)
            if idx >= 0:
                chunks.append(f"--- {key} at {idx} ---\n")
                chunks.append(text[idx : idx + 2800] + "\n\n")
        found += 1
        if found >= 6:
            break
out = r"C:\Users\zakir\Desktop\vbiz-me-backend\tmp-extract-plan.out.txt"
with open(out, "w", encoding="utf-8") as wf:
    wf.write("".join(chunks))
    wf.write(f"FOUND {found}\n")
print("wrote", out, "FOUND", found)
