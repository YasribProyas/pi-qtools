#!/usr/bin/env bash
# End-to-end guard test against a local mock endpoint. Nothing leaves 127.0.0.1 and
# nothing touches ~/.pi/agent: the run uses a throwaway PI_CODING_AGENT_DIR.
#
#   test/injection.e2e.sh
#
# Asserts three things about the main-loop enable_search injection:
#   1. a family rule that says YES actually injects;
#   2. glm-family and unmeasured ids never inject (fail-safe default);
#   3. when a family guess is WRONG and the endpoint 400s, the model is learned into
#      config.searchBlocklist and the very next turn works.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ext="$here/../extensions/qtools.ts"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/qtools-e2e.XXXXXX")"
port="${PORT:-8799}"
log="$sandbox/mock.jsonl"
provider="qwen-token-plan-e2e"   # must start with PROVIDER_PREFIX so isQwen() matches

pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1"; fail=$((fail+1)); }

cleanup() {
  [ -n "${srv:-}" ] && kill "$srv" 2>/dev/null
  rm -rf "$sandbox"
}
trap cleanup EXIT

# --- isolated agent dir with only the models under test ------------------------
mkdir -p "$sandbox"
cat > "$sandbox/models.json" <<JSON
{
  "providers": {
    "$provider": {
      "baseUrl": "http://127.0.0.1:$port/v1",
      "api": "openai-completions",
      "apiKey": "mock-key",
      "models": [
        { "id": "qwen3.9-max", "contextWindow": 200000, "maxTokens": 1024 },
        { "id": "glm-5.9", "contextWindow": 200000, "maxTokens": 1024 },
        { "id": "kimi-k3", "contextWindow": 200000, "maxTokens": 1024 },
        { "id": "qwen3.9-flash-lies", "contextWindow": 200000, "maxTokens": 1024 }
      ]
    }
  }
}
JSON
echo '{}' > "$sandbox/settings.json"
export PI_CODING_AGENT_DIR="$sandbox"
export PI_OFFLINE=1

run_pi() {
  pi -e "$ext" --provider "$provider" --model "$1" --no-tools --no-session \
     -p "say ok" > "$sandbox/pi-$1.out" 2>&1
}

tail_q() { tail -n 3 "$sandbox/pi-$1.out" 2>/dev/null | sed 's/^/       | /'; }

injected() {
  python3 - "$log" "${1:-last}" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
if sys.argv[2] == "last":
    r = rows[-1] if rows else {}
    print("yes" if r.get("enable_search") is True else "no")
else:
    print("yes" if any(x.get("model") == sys.argv[2] and x.get("enable_search") is True for x in rows) else "no")
PY
}

rejected() {
  python3 - "$log" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print("yes" if rows and rows[-1].get("rejected") else "no")
PY
}

blocklist() {
  python3 - "$sandbox/qtools.json" <<'PY'
import json, os, sys
p = sys.argv[1]
print(",".join(json.load(open(p)).get("searchBlocklist", [])) if os.path.exists(p) else "")
PY
}

# --- mock: only "qwen3.9-flash-lies" rejects the injection, once ---------------
python3 "$here/mock_endpoint.py" --port "$port" --log "$log" \
  --reject-once "qwen3.9-flash-lies" --reset > "$sandbox/mock.out" 2>&1 &
srv=$!
for _ in $(seq 40); do
  python3 -c "import socket,sys; sys.exit(socket.socket().connect_ex(('127.0.0.1',$port)))" && break
  sleep 0.25
done
: > "$log"

echo "[1] qwen3.9-max        family rule says search YES  -> must inject"
run_pi qwen3.9-max
[ "$(injected)" = "yes" ] && ok "enable_search injected" || { bad "no injection"; tail_q qwen3.9-max; }

echo "[2] glm-5.9            family rule says search NO   -> must not inject"
run_pi glm-5.9
[ "$(injected)" = "no" ] && ok "glm family left alone" || { bad "injected into glm family"; tail_q glm-5.9; }

echo "[3] kimi-k3            unmeasured id               -> must not inject (fail-safe)"
run_pi kimi-k3
[ "$(injected)" = "no" ] && ok "unmeasured id left alone" || { bad "injected into an unmeasured id"; tail_q kimi-k3; }

echo "[4] qwen3.9-flash-lies  family guess is WRONG       -> 400, learn, then heal"
run_pi qwen3.9-flash-lies
[ "$(rejected)" = "yes" ] && ok "poison reproduced: endpoint 400'd the injected request" \
  || { bad "expected the injected request to be rejected"; tail_q qwen3.9-flash-lies; }
case "$(blocklist)" in
  *qwen3.9-flash-lies*) ok "learned into config.searchBlocklist" ;;
  *) bad "not learned (blocklist='$(blocklist)')" ;;
esac
: > "$log"
run_pi qwen3.9-flash-lies
[ "$(injected)" = "no" ] && ok "next turn skips the injection (self-healed)" \
  || { bad "still injecting after the 400"; tail_q qwen3.9-flash-lies; }
grep -q "MOCK-OK" "$sandbox/pi-qwen3.9-flash-lies.out" && ok "next turn completed" \
  || bad "next turn did not complete: $(tail -n 2 "$sandbox/pi-qwen3.9-flash-lies.out")"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
