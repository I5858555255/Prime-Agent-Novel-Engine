"""Tavily integration: tools auto-discovered from Tavily's official MCP server.

Usage in the kernel:

    import tavily
    results = await tavily.tavily_search(query="latest AI news")
"""

from __future__ import annotations

from rlm import McpIntegration

__all__ = ["Tavily", "tavily"]


class Tavily(McpIntegration):
    server = "tavily"
    url = "https://mcp.tavily.com/mcp"


tavily = Tavily()

# Don't forward names the kernel bootstrap probes (e.g. `run`) or it wraps the
# module as a callable skill and breaks `await tavily.<tool>()` dispatch.
_RESERVED = {"run", "__wrapped__", "__call__"}


def __getattr__(name: str):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(tavily, name)
