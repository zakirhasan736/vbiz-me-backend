#!/usr/bin/env python3

import os
from pathlib import PurePosixPath
from urllib.parse import urlparse, unquote

import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor


PROFILE_LEGACY_ID = 91

REMAINING_IDS = [
    125,
    433,
    783,
    912,
    913,
    914,
    915,
    916,
]


# ============================================================
# HELPERS
# ============================================================

def clean(value):
    if value is None:
        return ""
    return str(value).strip()


def basename(value):
    value = clean(value)

    if not value:
        return ""

    try:
        parsed = urlparse(value)

        if parsed.scheme in ("http", "https"):
            return unquote(
                PurePosixPath(parsed.path).name
            ).lower()

    except Exception:
        pass

    return unquote(
        PurePosixPath(value).name
    ).lower()


def is_http(value):
    value = clean(value)
    return value.startswith(
        ("http://", "https://")
    )


def print_section(title):
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def compact_old_portfolio(row):
    wanted = [
        "id",
        "profile_id",
        "title",
        "description",
        "url",
        "image",
        "image_url",
        "attachment",
        "file",
        "status",
        "created_at",
        "updated_at",
    ]

    result = {}

    for key in wanted:
        if key in row:
            result[key] = row.get(key)

    return result


# ============================================================
# CONNECTIONS
# ============================================================

old_url = urlparse(
    os.environ["LARAVEL_MYSQL_URL"]
)

my = pymysql.connect(
    host=old_url.hostname,
    port=old_url.port or 3306,
    user=unquote(old_url.username or ""),
    password=unquote(old_url.password or ""),
    database=(old_url.path or "").lstrip("/"),
    charset="utf8mb4",
    cursorclass=pymysql.cursors.DictCursor,
    ssl_disabled=True,
)

pg = psycopg2.connect(
    os.environ["NEW_DATABASE_URL"]
)

pg.autocommit = False


try:

    # ========================================================
    # TARGET PROFILE
    # ========================================================

    with pg.cursor(
        cursor_factory=RealDictCursor
    ) as c:

        c.execute("""
            SELECT
                id,
                "legacyId",
                name,
                slug
            FROM "Profile"
            WHERE "legacyId"=%s
        """, (PROFILE_LEGACY_ID,))

        profiles = c.fetchall()

    if len(profiles) != 1:
        raise RuntimeError(
            f"Expected exactly one Profile legacyId "
            f"{PROFILE_LEGACY_ID}, found {len(profiles)}"
        )

    profile = dict(profiles[0])
    profile_id = profile["id"]

    print_section("TARGET PROFILE")
    print(profile)


    # ========================================================
    # LOAD REMAINING OLD PORTFOLIOS
    # ========================================================

    placeholders = ",".join(
        ["%s"] * len(REMAINING_IDS)
    )

    with my.cursor() as c:

        c.execute(
            f"""
            SELECT *
            FROM portfolios
            WHERE id IN ({placeholders})
            ORDER BY id
            """,
            REMAINING_IDS,
        )

        old_portfolios = c.fetchall()


    old_by_id = {
        int(r["id"]): r
        for r in old_portfolios
    }


    # ========================================================
    # VERIFY OLD OWNERSHIP
    # ========================================================

    for legacy_id in REMAINING_IDS:

        old = old_by_id.get(legacy_id)

        if not old:
            raise RuntimeError(
                f"OLD Portfolio {legacy_id} missing"
            )

        if int(old["profile_id"]) != PROFILE_LEGACY_ID:
            raise RuntimeError(
                f"OLD Portfolio {legacy_id} belongs "
                f"to profile {old['profile_id']}"
            )


    # ========================================================
    # LOAD OLD ATTACHMENTS
    # ========================================================

    with my.cursor() as c:

        c.execute(
            f"""
            SELECT *
            FROM attachments
            WHERE attachmentable_type LIKE '%%Portfolio%%'
              AND attachmentable_id IN ({placeholders})
            ORDER BY attachmentable_id,id
            """,
            REMAINING_IDS,
        )

        old_attachments = c.fetchall()


    old_attach_by_portfolio = {}

    for row in old_attachments:

        pid = int(
            row["attachmentable_id"]
        )

        old_attach_by_portfolio.setdefault(
            pid,
            [],
        ).append(row)


    old_attachment_ids = [
        int(r["id"])
        for r in old_attachments
    ]


    # ========================================================
    # LOAD MIGRATED POSTGRES ATTACHMENTS
    # ========================================================

    pg_attachment_by_legacy = {}

    if old_attachment_ids:

        with pg.cursor(
            cursor_factory=RealDictCursor
        ) as c:

            c.execute("""
                SELECT
                    id,
                    "legacyId",
                    "profileId",
                    "attachableType",
                    "attachableId",
                    "attachmentTypeId",
                    "docName",
                    url,
                    "publicId",
                    "resourceType",
                    format,
                    extension,
                    "mimeType",
                    bytes,
                    "createdAt"
                FROM "Attachment"
                WHERE "legacyId" = ANY(%s)
                ORDER BY "legacyId"
            """, (old_attachment_ids,))

            for row in c.fetchall():

                r = dict(row)

                pg_attachment_by_legacy[
                    int(r["legacyId"])
                ] = r


    # ========================================================
    # LOAD ALL CURRENT MICHAELANGELO PORTFOLIOS
    # ========================================================

    with pg.cursor(
        cursor_factory=RealDictCursor
    ) as c:

        c.execute("""
            SELECT
                id,
                "legacyId",
                "profileId",
                title,
                description,
                "imageUrl",
                "attachmentUrl",
                "attachmentName",
                "sortOrder",
                "createdAt",
                "updatedAt"
            FROM "Portfolio"
            WHERE "profileId"=%s
            ORDER BY "createdAt",id
        """, (profile_id,))

        new_portfolios = [
            dict(r)
            for r in c.fetchall()
        ]


    portfolio_by_id = {
        r["id"]: r
        for r in new_portfolios
    }


    print_section(
        "CURRENT MICHAELANGELO POSTGRES PORTFOLIOS"
    )

    print(
        "Current Portfolio rows:",
        len(new_portfolios),
    )

    for row in new_portfolios:

        print({
            "id": row["id"],
            "legacyId": row["legacyId"],
            "title": row["title"],
            "imageUrl": row["imageUrl"],
            "attachmentUrl":
                row["attachmentUrl"],
            "attachmentName":
                row["attachmentName"],
        })


    # ========================================================
    # ANALYZE EACH REMAINING OLD PORTFOLIO
    # ========================================================

    results = []


    for legacy_id in REMAINING_IDS:

        old = old_by_id[legacy_id]

        print_section(
            f"OLD PORTFOLIO {legacy_id} | "
            f"{old.get('title')}"
        )

        print("OLD PORTFOLIO:")
        print(
            compact_old_portfolio(old)
        )

        old_atts = (
            old_attach_by_portfolio.get(
                legacy_id,
                [],
            )
        )

        print()
        print(
            "OLD ATTACHMENT COUNT:",
            len(old_atts),
        )


        # ----------------------------------------------------
        # Candidate collections
        # ----------------------------------------------------

        direct_parent_candidates = {}
        exact_url_candidates = {}
        filename_candidates = {}
        title_candidates = {}
        legacy_candidates = {}


        # ----------------------------------------------------
        # Existing legacyId match
        # ----------------------------------------------------

        for p in new_portfolios:

            if p["legacyId"] == legacy_id:

                legacy_candidates[
                    p["id"]
                ] = p


        # ----------------------------------------------------
        # Exact title matches
        # ----------------------------------------------------

        old_title = clean(
            old.get("title")
        ).lower()

        if old_title:

            for p in new_portfolios:

                if clean(
                    p.get("title")
                ).lower() == old_title:

                    title_candidates[
                        p["id"]
                    ] = p


        # ----------------------------------------------------
        # Analyze each old attachment
        # ----------------------------------------------------

        for old_a in old_atts:

            aid = int(
                old_a["id"]
            )

            print()
            print("-" * 60)

            print("OLD ATTACHMENT:", {
                "id": aid,
                "portfolioId":
                    old_a.get(
                        "attachmentable_id"
                    ),
                "typeId":
                    old_a.get(
                        "attachment_type_id"
                    ),
                "docName":
                    old_a.get(
                        "doc_name"
                    ),
                "createdAt":
                    old_a.get(
                        "created_at"
                    ),
            })


            new_a = (
                pg_attachment_by_legacy.get(
                    aid
                )
            )

            print(
                "POSTGRES ATTACHMENT:",
                new_a,
            )


            if not new_a:

                print(
                    "*** MISSING POSTGRES "
                    "ATTACHMENT ***"
                )

                continue


            # -----------------------------------------------
            # Current attachableId points to real Portfolio?
            # -----------------------------------------------

            parent_id = (
                new_a.get(
                    "attachableId"
                )
            )

            if parent_id in portfolio_by_id:

                direct_parent_candidates[
                    parent_id
                ] = portfolio_by_id[
                    parent_id
                ]

                print(
                    "CURRENT ATTACHABLE-ID "
                    "POINTS TO REAL PORTFOLIO:",
                    parent_id,
                )

            else:

                print(
                    "CURRENT ATTACHABLE-ID "
                    "IS NOT A CURRENT "
                    "MICHAELANGELO PORTFOLIO:",
                    parent_id,
                )


            # -----------------------------------------------
            # Media URL
            # -----------------------------------------------

            attachment_url = clean(
                new_a.get("url")
            )

            attachment_filename = basename(
                attachment_url
                or new_a.get("docName")
                or old_a.get("doc_name")
            )

            print(
                "ATTACHMENT URL TYPE:",
                (
                    "HTTP/S3"
                    if is_http(
                        attachment_url
                    )
                    else "FILENAME/EMPTY"
                ),
            )

            print(
                "NORMALIZED FILE:",
                attachment_filename,
            )


            # -----------------------------------------------
            # Search all current Portfolio destinations
            # -----------------------------------------------

            for p in new_portfolios:

                portfolio_urls = [
                    clean(
                        p.get("imageUrl")
                    ),
                    clean(
                        p.get(
                            "attachmentUrl"
                        )
                    ),
                ]


                # EXACT FULL URL = strong evidence

                if (
                    is_http(attachment_url)
                    and attachment_url
                    in portfolio_urls
                ):

                    exact_url_candidates[
                        p["id"]
                    ] = p


                # filename = weak evidence only

                if attachment_filename:

                    candidate_names = {
                        basename(
                            p.get(
                                "imageUrl"
                            )
                        ),
                        basename(
                            p.get(
                                "attachmentUrl"
                            )
                        ),
                        basename(
                            p.get(
                                "attachmentName"
                            )
                        ),
                    }

                    candidate_names.discard("")

                    if (
                        attachment_filename
                        in candidate_names
                    ):

                        filename_candidates[
                            p["id"]
                        ] = p


        # ----------------------------------------------------
        # PRINT CANDIDATES
        # ----------------------------------------------------

        def candidate_summary(
            collection
        ):
            return [
                {
                    "id": p["id"],
                    "legacyId":
                        p["legacyId"],
                    "title":
                        p["title"],
                    "imageUrl":
                        p["imageUrl"],
                    "attachmentUrl":
                        p["attachmentUrl"],
                    "attachmentName":
                        p[
                            "attachmentName"
                        ],
                }
                for p
                in collection.values()
            ]


        print()
        print(
            "EXISTING LEGACY-ID MATCH:"
        )
        print(
            candidate_summary(
                legacy_candidates
            )
            or "NONE"
        )


        print()
        print(
            "DIRECT ATTACHABLE-ID CANDIDATES:"
        )
        print(
            candidate_summary(
                direct_parent_candidates
            )
            or "NONE"
        )


        print()
        print(
            "EXACT FULL MEDIA URL CANDIDATES:"
        )
        print(
            candidate_summary(
                exact_url_candidates
            )
            or "NONE"
        )


        print()
        print(
            "FILENAME CANDIDATES "
            "(WEAK — NOT PROOF):"
        )
        print(
            candidate_summary(
                filename_candidates
            )
            or "NONE"
        )


        print()
        print(
            "TITLE CANDIDATES "
            "(WEAK — NOT PROOF):"
        )
        print(
            candidate_summary(
                title_candidates
            )
            or "NONE"
        )


        # ----------------------------------------------------
        # SAFE CLASSIFICATION
        # ----------------------------------------------------

        proven = None
        reason = None


        # Existing legacy ID is strongest if unique.

        if len(
            legacy_candidates
        ) == 1:

            proven = next(
                iter(
                    legacy_candidates
                    .values()
                )
            )

            reason = (
                "EXISTING LEGACY ID"
            )


        # Unique exact URL is authoritative.

        elif len(
            exact_url_candidates
        ) == 1:

            proven = next(
                iter(
                    exact_url_candidates
                    .values()
                )
            )

            reason = (
                "UNIQUE EXACT FULL MEDIA URL"
            )


        # Direct relationship is useful only if unique.

        elif len(
            direct_parent_candidates
        ) == 1:

            proven = next(
                iter(
                    direct_parent_candidates
                    .values()
                )
            )

            reason = (
                "UNIQUE EXISTING "
                "ATTACHMENT PARENT"
            )


        if proven:

            status = "PROVEN"

            print()
            print(
                "*** RESULT: PROVEN ***"
            )

            print({
                "oldPortfolioId":
                    legacy_id,
                "newPortfolioId":
                    proven["id"],
                "reason":
                    reason,
            })

        else:

            status = "UNRESOLVED"

            print()
            print(
                "*** RESULT: UNRESOLVED "
                "— DO NOT WRITE ***"
            )


        results.append({
            "legacyId": legacy_id,
            "title":
                old.get("title"),
            "status":
                status,
            "newPortfolioId":
                (
                    proven["id"]
                    if proven
                    else None
                ),
            "reason":
                reason,
            "oldAttachments":
                len(old_atts),
            "missingAttachments":
                sum(
                    1
                    for a in old_atts
                    if int(a["id"])
                    not in
                    pg_attachment_by_legacy
                ),
        })


    # ========================================================
    # FINAL SUMMARY
    # ========================================================

    print_section(
        "FINAL REMAINING MICHAELANGELO AUDIT"
    )


    for row in results:
        print(row)


    print()

    print(
        "Remaining portfolios checked:",
        len(results),
    )

    print(
        "Proven:",
        sum(
            r["status"] == "PROVEN"
            for r in results
        ),
    )

    print(
        "Still unresolved:",
        sum(
            r["status"] == "UNRESOLVED"
            for r in results
        ),
    )

    print(
        "Missing PostgreSQL "
        "attachment records:",
        sum(
            r["missingAttachments"]
            for r in results
        ),
    )


    # Absolutely no write.
    pg.rollback()

    print()
    print(
        "READ ONLY — NOTHING CHANGED"
    )


finally:

    my.close()
    pg.close()
