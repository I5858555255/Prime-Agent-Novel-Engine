"""Linear integration: tools auto-discovered from Linear's official MCP server.

Usage in the kernel:

    import linear
    issues = await linear.list_issues(team="Engineering")
"""

from __future__ import annotations

from rlm import McpIntegration

__all__ = ["Linear", "linear"]


class Linear(McpIntegration):
    server = "linear"
    url = "https://mcp.linear.app/mcp"


linear = Linear()


def __getattr__(name: str):
    # Forward bare module-level access (e.g. linear.list_issues) to the instance,
    # so `import linear; await linear.list_issues(...)` works without `.linear`.
    return getattr(linear, name)
