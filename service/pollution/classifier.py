"""Cheap multilingual pollution prefilter with an optional LLM second pass."""
from __future__ import annotations

import json
import logging
import os
import re
from .completion_config import completion_config
from .net import fetch

logger = logging.getLogger(__name__)

# A report must name either the Caspian or a verified regional place/operator.
# These expressions deliberately contain names only; they are not geocoding data.
_REGIONAL_RE = re.compile(
    r"(?<!\w)(?:"
    r"каспи\w*|caspian(?:\s+sea)?|"
    r"аташ|atash|"
    r"тенгиз|теңіз\s+(?:кен\s+орны|мұнай\s+кені)|tengiz|"
    r"кашаган|қашаған|kashagan|qashagan|"
    r"кульжан|күлжан|kulzhan|qulzhan|"
    r"мангистау|маңғыстау|mangystau|"
    r"кокжиде|көкжиде|kokzhide|"
    r"актобе|ақтөбе|aktobe|"
    r"атырау|atyrau|актау|ақтау|aktau|"
    r"каламкас|қаламқас|kalamkas|"
    r"кара жанбас|каражанбас|қаражанбас|karazhanbas|qarazhanbas|"
    r"дунга|dunga|кендерли|kend(?:e|ı)rli|"
    r"баутино|bautino|курык|құрық|kuryk|форт[-\s]?шевченко|fort[-\s]?shevchenko|"
    r"индербор|индерборский|inderbor|"
    r"ганюшкино|курмангазы|құрманғазы|ganyushkino|kurmangazy|"
    r"котяевка|бокейхан|бөкейхан|kotyaevka|bokeihan|"
    r"курилкино|аккизтогай|аккиизтогай|ақкиізтоғай|aqkiiztogan|"
    r"пос(?:елок|ёлок)?\.?\s*дамба|damba\s+village|"
    r"\bncoc\b|north\s+caspian\s+operating\s+company|"
    r"тенгизшевройл|tengizchevroil|"
    r"мангистаумунайгаз|маңғыстаумұнайгаз|mangistaumunaigas|"
    r"казмунайгаз|қазмұнайгаз|kazmunaygas"
    r")(?!\w)",
    re.IGNORECASE,
)

_POLLUTION_RE = re.compile(
    r"(?:"
    r"нефт\w*\s+(?:(?:пятн|пятен)\w*|разлив\w*)|"
    r"маслян\w*\s+(?:пятн|пятен)\w*|маслянист\w*\s+(?:пятн|пятен)\w*|"
    r"разлив\w*|утеч\w*|загрязнен\w*|загрязнён\w*|"
    r"сброс\w*|сточн\w*\s+вод\w*|выброс\w*|"
    r"возгоран\w*|пожар\w*|черн\w*\s+дым\w*|чёрн\w*\s+дым\w*|"
    r"мұнай\s+(?:төгі\w*|дағ\w*)|ласт\w*|төгінд\w*|"
    r"ағып\s+кет\w*|шығарынд\w*|өрт\w*|қара\s+түтін\w*|"
    r"\boil\s+(?:spill|slick|sheen|leak)\w*|"
    r"\bspill\w*|\bslick\w*|\bsheen\w*|\bleak(?:age)?\w*|"
    r"\bpollut\w*|\bcontaminat\w*|\bdischarg\w*|\bemission\w*|"
    r"\bflar(?:e|ing)\w*|\bfire\b|\bblack\s+smoke\b"
    r")",
    re.IGNORECASE,
)


def lexical_prefilter(text: str) -> bool:
    """Return whether text passes the mandatory regional + pollution gate."""
    if not isinstance(text, str) or not text.strip():
        return False
    return bool(_REGIONAL_RE.search(text) and _POLLUTION_RE.search(text))


def _timeout_seconds() -> float:
    try:
        value = float(os.environ.get("POLLUTION_CLASSIFIER_TIMEOUT", "5"))
    except ValueError:
        value = 5.0
    return min(30.0, max(1.0, value))



def _classifier_config() -> tuple[str, str, str | None] | None:
    return completion_config("POLLUTION_CLASSIFIER")


def _classify_with_endpoint(text: str, endpoint: str, model: str, key: str | None) -> bool:
    prompt = (
        "Answer exactly yes or no. Is the text about a reported, alleged, investigated, "
        "or denied oil/pollution/emission/fire incident in the Caspian region? A denial of "
        "an alleged incident is still relevant. General ecology without a pollution event "
        f"is no.\n\nText:\n{text[:3000]}"
    )
    payload = json.dumps(
        {
            "model": model,
            "temperature": 0,
            "max_tokens": 128,
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "SEALv-Pollution/1.0",
    }
    if key:
        headers["Authorization"] = f"Bearer {key}"
    response = fetch(
        endpoint,
        data=payload,
        headers=headers,
        method="POST",
        timeout=_timeout_seconds(),
        max_bytes=1024 * 1024,
    )
    data = json.loads(response.body.decode("utf-8"))
    content = data["choices"][0]["message"]["content"]
    answer = str(content).strip().lower()
    match = re.search(r"\b(yes|no)\b", answer)
    if not match:
        raise ValueError(f"classifier returned an unparseable answer: {answer[:80]!r}")
    return match.group(1) == "yes"


def is_pollution_article(text: str) -> bool:
    """Classify a report, always requiring the cheap lexical gate first.

    The optional remote classifier may reject a lexical match. Endpoint failures
    are logged and fail open only because the mandatory lexical gate has passed.
    """
    if not lexical_prefilter(text):
        return False
    config = _classifier_config()
    if config is None:
        return True
    try:
        return _classify_with_endpoint(text, *config)
    except Exception as exc:
        logger.warning(
            "pollution classifier failed; accepting lexical match: endpoint=%s error=%s",
            config[0],
            type(exc).__name__,
        )
        return True
