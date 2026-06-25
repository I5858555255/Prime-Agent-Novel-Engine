"""Notion integration: tools auto-discovered from Notion's official MCP server.

Usage in the kernel:

    import notion
    results = await notion.search(query="roadmap")
"""

from __future__ import annotations

from rlm import McpIntegration

__all__ = ["Notion", "notion"]


class Notion(McpIntegration):
    server = "notion"
    url = "https://mcp.notion.com/mcp"


notion = Notion()


def __getattr__(name: str):
    return getattr(notion, name)
