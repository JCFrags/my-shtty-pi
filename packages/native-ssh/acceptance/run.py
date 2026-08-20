#!/usr/bin/env python3
import json, os, pathlib, subprocess, tempfile

PACKAGE = pathlib.Path(__file__).resolve().parents[1]
boundary = pathlib.Path(tempfile.mkdtemp(prefix="pi-native-ssh-acceptance-", dir="/tmp"))
config = boundary / "pi-config"; sessions = boundary / "sessions"
config.mkdir(mode=0o700); sessions.mkdir(mode=0o700)
output = boundary / "result.json"; events = boundary / "rpc.jsonl"
env = os.environ.copy(); env.update({"PI_CODING_AGENT_DIR": str(config), "PI_NATIVE_SSH_CONFIG": str(pathlib.Path.home() / ".config/pi-native-ssh/config.json"), "PI_NATIVE_SSH_ACCEPTANCE_OUTPUT": str(output), "PI_OFFLINE": "1"})
command = ["pi", "--mode", "rpc", "--no-session", "--session-dir", str(sessions), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline", "--approve", "-e", str(PACKAGE / "acceptance/harness.ts")]
proc = subprocess.Popen(command, cwd=boundary, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
proc.stdin.write(json.dumps({"id":"accept","type":"prompt","message":"/accept-native-ssh"}) + "\n"); proc.stdin.flush()
with events.open("w", encoding="utf8") as log:
    while True:
        line = proc.stdout.readline()
        if not line: break
        log.write(line); log.flush()
        event = json.loads(line)
        if event.get("type") == "response" and event.get("command") == "prompt": break
proc.stdin.close(); proc.wait(timeout=10); stderr = proc.stderr.read()
if proc.returncode != 0 or stderr or not output.exists() or not json.loads(output.read_text())["passed"]:
    raise SystemExit(json.dumps({"passed":False,"exitCode":proc.returncode,"stderr":stderr,"boundary":str(boundary)}))
print(json.dumps({"passed":True,"exitCode":proc.returncode,"boundary":str(boundary),"result":str(output),"events":str(events)}))
