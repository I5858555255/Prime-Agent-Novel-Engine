from __future__ import annotations

import asyncio
import xml.etree.ElementTree as ET
from typing import Literal
from urllib.parse import quote_plus, urlencode
from urllib.request import Request, urlopen


ATOM_NS = "http://www.w3.org/2005/Atom"
OPENSEARCH_NS = "http://a9.com/-/spec/opensearch/1.1/"
NS = {"atom": ATOM_NS, "opensearch": OPENSEARCH_NS}


def _text(element: ET.Element, path: str) -> str | None:
    found = element.find(path, NS)
    if found is None or found.text is None:
        return None
    return " ".join(found.text.split())


def _entry_id_to_abs_url(entry_id: str | None) -> str | None:
    if entry_id is None:
        return None
    return entry_id.replace("http://", "https://")


def _entry_id_to_short_id(entry_id: str | None) -> str | None:
    if entry_id is None:
        return None
    return entry_id.rstrip("/").rsplit("/", maxsplit=1)[-1]


def _parse_entry(entry: ET.Element) -> dict[str, object]:
    entry_id = _text(entry, "atom:id")
    links: dict[str, str] = {}
    for link in entry.findall("atom:link", NS):
        href = link.attrib.get("href")
        if not href:
            continue
        rel = link.attrib.get("rel", "alternate")
        title = link.attrib.get("title")
        if title == "pdf":
            links["pdf"] = href.replace("http://", "https://")
        elif rel == "alternate":
            links["abs"] = href.replace("http://", "https://")

    authors = [
        name
        for author in entry.findall("atom:author", NS)
        if (name := _text(author, "atom:name")) is not None
    ]
    categories = [
        category.attrib["term"]
        for category in entry.findall("atom:category", NS)
        if "term" in category.attrib
    ]

    abs_url = links.get("abs") or _entry_id_to_abs_url(entry_id)
    return {
        "id": _entry_id_to_short_id(entry_id),
        "title": _text(entry, "atom:title"),
        "summary": _text(entry, "atom:summary"),
        "authors": authors,
        "categories": categories,
        "published": _text(entry, "atom:published"),
        "updated": _text(entry, "atom:updated"),
        "abs_url": abs_url,
        "pdf_url": links.get("pdf"),
    }


def _parse_feed(document: str) -> dict[str, object]:
    root = ET.fromstring(document)
    entries = [_parse_entry(entry) for entry in root.findall("atom:entry", NS)]
    total_results = _text(root, "opensearch:totalResults")
    return {
        "total_results": int(total_results) if total_results else len(entries),
        "entries": entries,
    }


def _fetch_atom(url: str, timeout_seconds: float) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": (
                "rlm-skill-arxiv/0.1 "
                "(https://primeintellect.ai; research agent)"
            )
        },
    )
    with urlopen(request, timeout=timeout_seconds) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def _build_query_url(
    *,
    query: str | None,
    ids: list[str] | None,
    max_results: int,
    sort_by: str,
    sort_order: str,
) -> str:
    params: dict[str, str | int] = {
        "start": 0,
        "max_results": max_results,
        "sortBy": sort_by,
        "sortOrder": sort_order,
    }
    if query:
        params["search_query"] = query
    if ids:
        params["id_list"] = ",".join(ids)
    encoded = urlencode(params, quote_via=quote_plus)
    return f"https://export.arxiv.org/api/query?{encoded}"


async def run(
    query: str | None = None,
    ids: list[str] | None = None,
    max_results: int = 5,
    sort_by: Literal["relevance", "lastUpdatedDate", "submittedDate"] = "relevance",
    sort_order: Literal["ascending", "descending"] = "descending",
    timeout_seconds: float = 15.0,
) -> dict[str, object]:
    """Search arXiv or fetch specific papers and return structured metadata.

    Args:
        query: arXiv API search query, such as `cat:cs.CL transformers`.
        ids: Specific arXiv IDs to fetch, such as `1706.03762`.
        max_results: Maximum number of entries to return.
        sort_by: arXiv sort key for query searches.
        sort_order: Sort order for query searches.
        timeout_seconds: Network timeout in seconds.

    Returns:
        A dictionary with request metadata and parsed paper entries.
    """
    cleaned_query = query.strip() if query else None
    cleaned_ids = [paper_id.strip() for paper_id in ids or [] if paper_id.strip()]
    if not cleaned_query and not cleaned_ids:
        raise ValueError("provide query or ids")
    if max_results < 1:
        raise ValueError("max_results must be at least 1")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be positive")

    url = _build_query_url(
        query=cleaned_query,
        ids=cleaned_ids or None,
        max_results=max_results,
        sort_by=sort_by,
        sort_order=sort_order,
    )
    document = await asyncio.to_thread(_fetch_atom, url, timeout_seconds)
    parsed = _parse_feed(document)
    parsed["query"] = cleaned_query
    parsed["ids"] = cleaned_ids
    parsed["request_url"] = url
    return parsed
