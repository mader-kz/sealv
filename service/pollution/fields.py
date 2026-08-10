"""Verified Caspian-region places with explicit uncertainty radii."""
from __future__ import annotations

import re

# name -> (latitude, longitude, radius_m, aliases)
#
# A radius describes the place/field extent; it is not coordinate precision.
# Keep this tuple contract because pollers consume it directly.
FIELDS: dict[str, tuple[float, float, float, list[str]]] = {
    "Kashagan": (
        45.35,
        52.15,
        10000,
        ["Кашаган", "Кашагана", "Кашагане", "Қашаған", "Qashagan", "D Island", "East Kashagan"],
    ),
    "Tengiz": (
        46.10,
        53.37,
        10000,
        ["Тенгиз", "Теңіз кен орны", "Tengiz field"],
    ),
    "Karachaganak": (51.30, 53.20, 10000, ["Карачаганак", "Қарашығанақ"]),
    "Dunga": (43.60, 51.90, 8000, ["Дунга", "Доңға"]),
    "Kalamkas-Khazar": (
        45.80,
        51.80,
        10000,
        ["Каламкас-Хазар", "Қаламқас-Хазар", "Каламкас", "Қаламқас", "Kalamkas"],
    ),
    "Kulzhan": (
        42.90,
        53.20,
        8000,
        ["Кульжан", "Күлжан", "Qulzhan", "Kulzhan field"],
    ),
    "Atash": (
        43.65,
        50.95,
        3000,
        ["Аташ", "Аташ жағажайы", "пляж Аташ", "Atash beach"],
    ),
    "Karazhanbas": (
        45.1283003,
        51.3954653,
        12500,
        ["Каражанбас", "Қаражанбас", "Qarajanbas", "Karazhanbas oil field"],
    ),
    "Bautino": (44.5585, 50.2502, 3000, ["Баутино"]),
    "Fort-Shevchenko": (
        44.5057466,
        50.2670471,
        3000,
        ["Форт-Шевченко", "Форт Шевченко", "Fort Shevchenko"],
    ),
    "Kuryk": (43.182, 51.596, 3000, ["Курык", "Құрық", "Kuryk"]),
    "Aktau": (43.655, 51.178, 5000, ["Актау", "Ақтау"]),
    "Koshkar-Ata": (
        43.7607,
        51.1952,
        3000,
        ["Кошкар-Ата", "Қошқар-Ата", "Koshkar Ata"],
    ),
    "Zhanaozen": (43.359, 52.8384, 5000, ["Жанаозен", "Жаңаөзен"]),
    "Kenderli Bay": (
        42.6630759,
        52.7036638,
        13000,
        ["Кендерли", "Кендірлі", "Kenderli Bay", "Kendırlı Bay"],
    ),
    "Atyrau": (47.1067183, 51.9138976, 12000, ["Атырау", "Atyrau city"]),
    "Inderbor": (
        48.5610249,
        51.7478775,
        4000,
        ["п. Индер", "поселок Индер", "посёлок Индер", "Индербор", "Индерборский"],
    ),
    "Kurmangazy": (
        46.6010491,
        49.2547557,
        5000,
        ["Ганюшкино", "Курмангазы", "Құрманғазы", "Ganyushkino"],
    ),
    "Bokeihan": (
        46.5465154,
        48.7644061,
        2000,
        ["Котяевка", "Бокейхан", "Бөкейхан", "Kotyaevka", "Bökeihan"],
    ),
    "Damba": (
        46.9578346,
        51.7510600,
        2500,
        ["поселок Дамба", "посёлок Дамба", "пос. Дамба", "Damba village"],
    ),
    "Kurilkino": (
        47.045854,
        51.859301,
        5000,
        ["Курилкино", "Курилкино көшесі"],
    ),
    "Aqkiiztogan": (
        47.0970310,
        54.3820040,
        1500,
        ["Аккизтогай", "Аккиизтогай", "Ақкиізтоғай", "Aqkiıztoğan"],
    ),
}

# Public records for coordinates added during the ingestion rebuild. Existing
# operational field coordinates retain their prior project provenance.
VERIFIED_PLACE_SOURCES: dict[str, str] = {
    "Karazhanbas": "https://www.openstreetmap.org/way/26396271",
    "Fort-Shevchenko": "https://www.openstreetmap.org/way/269807895",
    "Kenderli Bay": "https://www.openstreetmap.org/relation/20397451",
    "Atyrau": "https://www.openstreetmap.org/relation/9347854",
    "Inderbor": "https://www.openstreetmap.org/way/39248951",
    "Kurmangazy": "https://www.openstreetmap.org/way/193384840",
    "Bokeihan": "https://www.openstreetmap.org/relation/17419669",
    "Damba": "https://www.openstreetmap.org/relation/20950631",
    "Kurilkino": "https://yandex.kz/maps/ru/29407/atyrau-district/geo/kurilkino_koshesi/7022647250/",
    "Aqkiiztogan": "https://www.openstreetmap.org/way/245635162",
}


def _normalise(value: str) -> str:
    return " ".join(re.sub(r"[\W_]+", " ", value.casefold(), flags=re.UNICODE).split())


_ALIASES = sorted(
    (
        (_normalise(alias), name, lat, lng, radius)
        for name, (lat, lng, radius, aliases) in FIELDS.items()
        for alias in [name, *aliases]
    ),
    key=lambda item: len(item[0]),
    reverse=True,
)


def geocode_field(text: str) -> tuple[float, float, float, str] | None:
    """Resolve a verified named place without guessing an unmentioned location."""
    if not isinstance(text, str) or not text.strip():
        return None
    normalised = f" {_normalise(text)} "
    for alias, name, lat, lng, radius in _ALIASES:
        if f" {alias} " in normalised:
            return lat, lng, radius, name
    return None
