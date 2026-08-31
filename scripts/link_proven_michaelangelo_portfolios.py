#!/usr/bin/env python3

import os
import sys
from urllib.parse import urlparse, unquote

import pymysql
import psycopg2
from psycopg2.extras import RealDictCursor


APPLY = "--apply" in sys.argv

PROFILE_LEGACY_ID = 91

# OLD Portfolio ID -> NEW Portfolio ID -> OLD Attachment ID
MAPPINGS = [
    (121, "cmtgtwr6l001v4ckca37q0a0c", 854),
    (123, "cmtgtwr6h001u4ckc8op59fdd", 856),
    (430, "cmtgtwr6d001t4ckcud7t1wck", 2416),
    (431, "cmtgtwr6a001s4ckc3t2ytvvw", 2417),
    (432, "cmtgtwr67001r4ckcr4cb2i80", 2418),
    (852, "cmtgtwr5t001o4ckcygarj8md", 4943),
]


# ============================================================
# CONNECTIONS
# ============================================================

old_url = urlparse(os.environ["LARAVEL_MYSQL_URL"])

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

pg = psycopg2.connect(os.environ["NEW_DATABASE_URL"])
pg.autocommit = False


try:

    # ========================================================
    # TARGET PROFILE
    # ========================================================

    with pg.cursor(cursor_factory=RealDictCursor) as c:

        c.execute("""
            SELECT id,"legacyId",name,slug
            FROM "Profile"
            WHERE "legacyId"=%s
        """, (PROFILE_LEGACY_ID,))

        rows = c.fetchall()

    if len(rows) != 1:
        raise RuntimeError(
            f"Expected exactly one NEW Profile legacyId "
            f"{PROFILE_LEGACY_ID}; found {len(rows)}"
        )

    profile = dict(rows[0])
    profile_id = profile["id"]

    print()
    print("TARGET:", profile)


    # ========================================================
    # VERIFY EVERY MAPPING BEFORE ANY WRITE
    # ========================================================

    plan = []

    for old_portfolio_id, new_portfolio_id, old_attachment_id in MAPPINGS:

        print()
        print("================================================")
        print("VERIFY OLD PORTFOLIO", old_portfolio_id)
        print("================================================")


        # ----------------------------------------------------
        # OLD Portfolio
        # ----------------------------------------------------

        with my.cursor() as c:

            c.execute("""
                SELECT *
                FROM portfolios
                WHERE id=%s
            """, (old_portfolio_id,))

            old_portfolio = c.fetchone()

        if not old_portfolio:
            raise RuntimeError(
                f"OLD Portfolio {old_portfolio_id} missing"
            )

        if int(old_portfolio["profile_id"]) != PROFILE_LEGACY_ID:
            raise RuntimeError(
                f"OLD Portfolio {old_portfolio_id} belongs to "
                f"profile {old_portfolio['profile_id']}, not 91"
            )


        # ----------------------------------------------------
        # OLD attachment authority
        # ----------------------------------------------------

        with my.cursor() as c:

            c.execute("""
                SELECT
                    id,
                    attachmentable_id,
                    attachmentable_type,
                    attachment_type_id,
                    doc_name
                FROM attachments
                WHERE id=%s
            """, (old_attachment_id,))

            old_attachment = c.fetchone()

        if not old_attachment:
            raise RuntimeError(
                f"OLD Attachment {old_attachment_id} missing"
            )

        if int(old_attachment["attachmentable_id"]) != old_portfolio_id:
            raise RuntimeError(
                f"OLD Attachment {old_attachment_id} points to "
                f"{old_attachment['attachmentable_id']}, expected "
                f"Portfolio {old_portfolio_id}"
            )

        if "Portfolio" not in str(
            old_attachment["attachmentable_type"]
        ):
            raise RuntimeError(
                f"OLD Attachment {old_attachment_id} is not Portfolio"
            )


        # ----------------------------------------------------
        # NEW Portfolio
        # ----------------------------------------------------

        with pg.cursor(cursor_factory=RealDictCursor) as c:

            c.execute("""
                SELECT
                    id,
                    "legacyId",
                    "profileId",
                    title,
                    "imageUrl",
                    "attachmentUrl"
                FROM "Portfolio"
                WHERE id=%s
            """, (new_portfolio_id,))

            new_portfolio = c.fetchone()

        if not new_portfolio:
            raise RuntimeError(
                f"NEW Portfolio {new_portfolio_id} missing"
            )

        new_portfolio = dict(new_portfolio)

        if new_portfolio["profileId"] != profile_id:
            raise RuntimeError(
                f"NEW Portfolio {new_portfolio_id} belongs to wrong Profile"
            )

        if new_portfolio["legacyId"] not in (
            None,
            old_portfolio_id,
        ):
            raise RuntimeError(
                f"NEW Portfolio {new_portfolio_id} already has "
                f"legacyId={new_portfolio['legacyId']}"
            )


        # ----------------------------------------------------
        # No other Portfolio can already own this legacyId
        # ----------------------------------------------------

        with pg.cursor(cursor_factory=RealDictCursor) as c:

            c.execute("""
                SELECT id,"profileId",title
                FROM "Portfolio"
                WHERE "legacyId"=%s
                  AND id<>%s
            """, (
                old_portfolio_id,
                new_portfolio_id,
            ))

            duplicate = c.fetchall()

        if duplicate:
            raise RuntimeError(
                f"OLD Portfolio legacyId {old_portfolio_id} is already "
                f"owned by another NEW Portfolio: {duplicate}"
            )


        # ----------------------------------------------------
        # NEW migrated Attachment
        # ----------------------------------------------------

        with pg.cursor(cursor_factory=RealDictCursor) as c:

            c.execute("""
                SELECT
                    id,
                    "legacyId",
                    "profileId",
                    "attachableType",
                    "attachableId",
                    url,
                    "publicId"
                FROM "Attachment"
                WHERE "legacyId"=%s
            """, (old_attachment_id,))

            attachments = c.fetchall()

        if len(attachments) != 1:
            raise RuntimeError(
                f"Expected one NEW Attachment legacyId "
                f"{old_attachment_id}; found {len(attachments)}"
            )

        new_attachment = dict(attachments[0])

        if new_attachment["profileId"] != profile_id:
            raise RuntimeError(
                f"Attachment {old_attachment_id} belongs to wrong Profile"
            )

        if "Portfolio" not in str(
            new_attachment["attachableType"]
        ):
            raise RuntimeError(
                f"Attachment {old_attachment_id} is not Portfolio type"
            )


        # ----------------------------------------------------
        # Exact media proof
        # ----------------------------------------------------

        attachment_url = (
            new_attachment["url"] or ""
        ).strip()

        if not attachment_url.startswith(
            ("http://", "https://")
        ):
            raise RuntimeError(
                f"Attachment {old_attachment_id} has no valid HTTP/S3 URL"
            )

        portfolio_urls = {
            (new_portfolio.get("imageUrl") or "").strip(),
            (new_portfolio.get("attachmentUrl") or "").strip(),
        }

        if attachment_url not in portfolio_urls:
            raise RuntimeError(
                f"EXACT MEDIA MISMATCH for OLD Portfolio "
                f"{old_portfolio_id}"
            )


        # ----------------------------------------------------
        # Verify unique exact URL match in Michaelangelo card
        # ----------------------------------------------------

        with pg.cursor(cursor_factory=RealDictCursor) as c:

            c.execute("""
                SELECT id
                FROM "Portfolio"
                WHERE "profileId"=%s
                  AND (
                       "imageUrl"=%s
                    OR "attachmentUrl"=%s
                  )
            """, (
                profile_id,
                attachment_url,
                attachment_url,
            ))

            matches = [
                r["id"]
                for r in c.fetchall()
            ]

        if matches != [new_portfolio_id]:
            raise RuntimeError(
                f"Media URL for legacy Portfolio {old_portfolio_id} "
                f"is not unique. Matches={matches}"
            )


        plan.append({
            "legacyPortfolioId": old_portfolio_id,
            "newPortfolioId": new_portfolio_id,
            "legacyAttachmentId": old_attachment_id,
            "newAttachmentId": new_attachment["id"],
            "currentAttachmentParent":
                new_attachment["attachableId"],
            "url": attachment_url,
        })

        print("SAFE:", plan[-1])


    # ========================================================
    # ALL SIX MUST VERIFY
    # ========================================================

    if len(plan) != len(MAPPINGS):
        raise RuntimeError(
            "Not all mappings verified"
        )

    print()
    print("========================================")
    print("ALL 6 MAPPINGS VERIFIED")
    print("========================================")


    if not APPLY:

        pg.rollback()

        print()
        print("DRY RUN ONLY — NOTHING CHANGED")
        print()
        print(
            "Run again with --apply after reviewing this output."
        )

        raise SystemExit(0)


    # ========================================================
    # APPLY
    # ========================================================

    with pg.cursor() as c:

        for row in plan:

            # Only establish the missing OLD identity.
            # Do NOT overwrite title/content/image fields.
            c.execute("""
                UPDATE "Portfolio"
                SET "legacyId"=%s
                WHERE id=%s
                  AND (
                       "legacyId" IS NULL
                    OR "legacyId"=%s
                  )
            """, (
                row["legacyPortfolioId"],
                row["newPortfolioId"],
                row["legacyPortfolioId"],
            ))

            if c.rowcount != 1:
                raise RuntimeError(
                    f"Portfolio update failed for "
                    f"{row['legacyPortfolioId']}"
                )


            # Repair exact Attachment relationship.
            c.execute("""
                UPDATE "Attachment"
                SET
                    "attachableId"=%s,
                    "profileId"=%s,
                    "attachableType"='App\\Models\\Portfolio'
                WHERE id=%s
            """, (
                row["newPortfolioId"],
                profile_id,
                row["newAttachmentId"],
            ))

            if c.rowcount != 1:
                raise RuntimeError(
                    f"Attachment repair failed for "
                    f"{row['legacyAttachmentId']}"
                )


    pg.commit()

    print()
    print("========================================")
    print("COMMITTED SUCCESSFULLY")
    print("========================================")
    print("Linked OLD Portfolios:", len(plan))


    # ========================================================
    # POST-COMMIT CHECK
    # ========================================================

    ids = [
        row["legacyPortfolioId"]
        for row in plan
    ]

    with pg.cursor(cursor_factory=RealDictCursor) as c:

        c.execute("""
            SELECT
                "legacyId",
                id,
                title,
                "imageUrl",
                "attachmentUrl"
            FROM "Portfolio"
            WHERE "legacyId" = ANY(%s)
            ORDER BY "legacyId"
        """, (ids,))

        results = [
            dict(r)
            for r in c.fetchall()
        ]

    print()
    print("POST-COMMIT PORTFOLIOS")
    print("======================")

    for r in results:
        print(r)

    if len(results) != 6:
        raise RuntimeError(
            f"Expected 6 mapped portfolios after commit; "
            f"found {len(results)}"
        )


finally:

    my.close()
    pg.close()
