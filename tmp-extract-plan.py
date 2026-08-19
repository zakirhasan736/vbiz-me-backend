import json

path = r"C:\Users\zakir\.cursor\projects\c-Users-zakir-Desktop-vbiz-me-administration\agent-transcripts\2427107d-ae61-4a7c-b19f-7fc6d7a2b6af\2427107d-ae61-4a7c-b19f-7fc6d7a2b6af.jsonl"
keys = [
    "One-Time Signup Fee",
    "GLOBAL PAC",
    "$10",
    "10 USD",
    "signup fee",
    "Manage Access",
]
out = []
with open(path, encoding="utf-8") as f:
    for i, line in enumerate(f, 1):
        if i not in (3583, 3584, 3587):
            continue
        obj = json.loads(line)
        content = obj.get("message", {}).get("content", [])
        texts = []
        for c in content:
            if isinstance(c, dict) and "text" in c:
                texts.append(c["text"])
        text = "\n".join(texts)
        out.append(f"===== {obj.get('role')} line {i} =====\n")
        for key in keys:
            idx = 0
            n = 0
            while n < 3:
                found = text.find(key, idx)
                if found < 0:
                    break
                start = max(0, found - 200)
                out.append(f"\n--- {key} @{found} ---\n")
                out.append(text[start : found + 1600] + "\n")
                idx = found + len(key)
                n += 1

with open(r"C:\Users\zakir\Desktop\vbiz-me-backend\tmp-extract-plan.out.txt", "w", encoding="utf-8") as wf:
    wf.write("".join(out))
print("ok")
