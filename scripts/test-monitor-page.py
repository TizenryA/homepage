#!/usr/bin/env python3
"""Static checks for the homepage monitor entry and standalone monitor page."""
from __future__ import annotations

import html.parser
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
MONITOR = ROOT / "monitor.html"
API_URL = "https://play.tizenry.xyz/monitor-api/v1/public/status"
REFRESH_URL = "https://play.tizenry.xyz/monitor-api/v1/public/refresh"


class DocumentParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tags: list[str] = []
        self.scripts: list[str] = []
        self._in_script = False
        self._script_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag)
        if tag == "script":
            self._in_script = True
            self._script_parts = []

    def handle_data(self, data: str) -> None:
        if self._in_script:
            self._script_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._in_script:
            self.scripts.append("".join(self._script_parts))
            self._in_script = False


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def parse_html(path: Path) -> tuple[str, DocumentParser]:
    text = path.read_text(encoding="utf-8")
    parser = DocumentParser()
    parser.feed(text)
    parser.close()
    check("<html" in text.lower(), f"{path.name}: missing html root")
    check("</html>" in text.lower(), f"{path.name}: missing html close tag")
    return text, parser


def check_js_syntax(parser: DocumentParser, path: Path) -> None:
    for index, script in enumerate(parser.scripts, start=1):
        with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8") as handle:
            handle.write(script)
            handle.flush()
            result = subprocess.run(
                ["node", "--check", handle.name],
                capture_output=True,
                text=True,
                check=False,
            )
        check(result.returncode == 0, f"{path.name}: script {index} syntax error: {result.stderr.strip()}")


def main() -> int:
    index_text, index_parser = parse_html(INDEX)
    monitor_text, monitor_parser = parse_html(MONITOR)

    check("./monitor.html" in index_text, "index.html: missing relative monitor entry")
    check("实时模型监控" in index_text, "index.html: missing monitor entry label")
    check("模型监测" not in index_text, "index.html: legacy monitor section remains")
    check("rv-monitor-panel" not in index_text, "index.html: legacy monitor container remains")
    check("rv-mrow" not in index_text, "index.html: legacy monitor row CSS/DOM remains")
    check("renderPanel" not in index_text, "index.html: legacy monitor list renderer remains")
    check("https://zcv2jk.zeabur.app/embed.html" not in index_text, "index.html: legacy embed link remains")
    check("fetch('./monitor.json" in index_text, "index.html: minimal snapshot summary loader is missing")
    for element_id in ("rvModelCount", "rvStatusDot", "rvServiceStatus", "rvHealthyRatio", "rvSuccessRate"):
        check(f'id="{element_id}"' in index_text, f"index.html: summary id {element_id} is missing")

    check(API_URL in monitor_text, "monitor.html: status API URL is missing")
    check(REFRESH_URL not in monitor_text, "monitor.html: public refresh endpoint must not be called")
    check("cache: 'no-store'" in monitor_text or 'cache: "no-store"' in monitor_text, "monitor.html: requests must use cache:no-store")
    check("method: 'POST'" not in monitor_text and 'method: "POST"' not in monitor_text, "monitor.html: manual refresh must not POST")
    check("function refreshNow" in monitor_text and "loadStatus()" in monitor_text, "monitor.html: manual GET refresh handler is missing")
    check("setInterval(loadStatus, 60000)" in monitor_text, "monitor.html: 60-second refresh interval is missing")
    check("monitor.json" in monitor_text, "monitor.html: historical snapshot fallback is missing")
    check("历史快照" in monitor_text, "monitor.html: fallback is not explicitly marked historical")
    check("prefers-reduced-motion" in monitor_text, "monitor.html: reduced-motion support is missing")
    check(not re.search(r"(?i)\b\d+(?:\.\d+)?px\b", monitor_text), "monitor.html: newly added px unit found")
    check_js_syntax(index_parser, INDEX)
    check_js_syntax(monitor_parser, MONITOR)
    print("monitor static checks: PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"monitor static checks: FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
