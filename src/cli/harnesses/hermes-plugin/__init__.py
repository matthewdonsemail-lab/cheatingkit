"""Inject source-linked CheatingKit context before each Hermes model turn."""
import json
import subprocess
from pathlib import Path


def _recall(user_message=None, session_id=None, **kwargs):
    if not user_message:
        return None
    command = json.loads((Path(__file__).parent / "command.json").read_text())
    payload = {"prompt": user_message, "session_id": session_id, "cwd": kwargs.get("cwd")}
    try:
        result = subprocess.run(command, input=json.dumps(payload), capture_output=True,
                                text=True, timeout=15, check=True)
        output = json.loads(result.stdout or "{}")
        context = output.get("hookSpecificOutput", {}).get("additionalContext")
        return {"context": context} if context else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def register(ctx):
    ctx.register_hook("pre_llm_call", _recall)
