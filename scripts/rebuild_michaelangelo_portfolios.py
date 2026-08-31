import os
import sys
import re
import json
import uuid
import getpass
import mimetypes
from pathlib import Path
from datetime import datetime

import boto3
import pymysql
import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import RealDictCursor


# ======================================================================================
# CONFIG
# ======================================================================================

OLD_PROFILE_ID = 91

BUCKET = "aws-s3-vbizme-vcard"
REGION = "us-east-2"

APPLY = "--apply" in sys.argv

load_dotenv(".env")


# ======================================================================================
# HELPERS
# ======================================================================================

def new_id():
    return "c" + uuid.uuid4().hex[:24]


def safe_filename(name):
    name = (name or "file").strip()
    name = name.replace(" ", "-")
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name)
    name = re.sub(r"-+", "-", name)
    return name.strip("-") or "file"


def ext_info(filename):
    ext = Path(filename or "").suffix.lower().lstrip(".")

    if ext == "jpg":
        fmt = "jpg"
        mime = "image/jpeg"
        resource = "image"
    elif ext == "jpeg":
        fmt = "jpeg"
        mime = "image/jpeg"
        resource = "image"
    elif ext == "png":
        fmt = "png"
        mime = "image/png"
        resource = "image"
    elif ext == "webp":
        fmt = "webp"
        mime = "image/webp"
        resource = "image"
    elif ext == "gif":
        fmt = "gif"
        mime = "image/gif"
        resource = "image"
    elif ext in ("mp4", "mov", "m4v", "webm", "avi"):
        fmt = ext
        mime = mimetypes.guess_type(filename)[0] or "video/mp4"
        resource = "video"
    else:
        fmt = ext or None
        mime = mimetypes.guess_type(filename or "")[0]
        resource = "video" if mime and mime.startswith("video/") else "image"

    return resource, fmt, ext or None, mime


def s3_key_from_url(url):
    if not url:
        return None

    marker = ".amazonaws.com/"
    if marker not in url:
        return None

    return url.split(marker, 1)[1]


def s3_exists(s3, key):
    if not key:
        return None

    try:
        r = s3.head_object(Bucket=BUCKET, Key=key)
        return {
            "key": key,
            "bytes": r["ContentLength"],
            "content_type": r.get("ContentType"),
        }
    except Exception:
        return None


def old_value(row, *names, default=None):
    for n in names:
        if n in row:
            return row[n]
    return default


# ======================================================================================
# CONNECTIONS
# ======================================================================================

database_url = os.getenv("DATABASE_URL")
if not database_url:
    raise RuntimeError("DATABASE_URL missing from .env")

database_url = database_url.split("?")[0]

mysql_host = os.getenv("OLD_MYSQL_HOST") or input("Old MySQL host: ").strip()
mysql_user = os.getenv("OLD_MYSQL_USER") or input("Old MySQL user: ").strip()
mysql_db = os.getenv("OLD_MYSQL_DB") or input("Old MySQL database: ").strip()

mysql_password = os.getenv("OLD_MYSQL_PASSWORD")
if not mysql_password:
    mysql_password = getpass.getpass("Old MySQL password: ")

if not mysql_host or not mysql_user or not mysql_db:
    raise RuntimeError("Old MySQL host/user/database are required")


s3 = boto3.client(
    "s3",
    region_name=REGION,
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
)

old = pymysql.connect(
    host=mysql_host,
    user=mysql_user,
    password=mysql_password,
    database=mysql_db,
    cursorclass=pymysql.cursors.DictCursor,
)

pg = psycopg2.connect(database_url)


# ======================================================================================
# LOAD OLD MYSQL SOURCE OF TRUTH
# ======================================================================================

try:
    with old.cursor() as c:

        c.execute("SHOW COLUMNS FROM portfolios")
        portfolio_columns = {r["Field"] for r in c.fetchall()}

        c.execute("SHOW COLUMNS FROM attachments")
        attachment_columns = {r["Field"] for r in c.fetchall()}

        if "attachable_id" in attachment_columns:
            old_attach_id_col = "attachable_id"
        elif "attachmentable_id" in attachment_columns:
            old_attach_id_col = "attachmentable_id"
        else:
            raise RuntimeError(
                "Cannot find attachable_id/attachmentable_id in old attachments table"
            )

        if "attachable_type" in attachment_columns:
            old_attach_type_col = "attachable_type"
        elif "attachmentable_type" in attachment_columns:
            old_attach_type_col = "attachmentable_type"
        else:
            raise RuntimeError(
                "Cannot find attachable_type/attachmentable_type in old attachments table"
            )

        c.execute("""
            SELECT *
            FROM portfolios
            WHERE profile_id = %s
            ORDER BY id
        """, (OLD_PROFILE_ID,))

        old_portfolios = c.fetchall()

        if not old_portfolios:
            raise RuntimeError("No old Portfolio rows found for profile 91")

        old_ids = [int(p["id"]) for p in old_portfolios]

        placeholders = ",".join(["%s"] * len(old_ids))

        sql = f"""
            SELECT *
            FROM attachments
            WHERE {old_attach_id_col} IN ({placeholders})
              AND {old_attach_type_col} LIKE %s
            ORDER BY {old_attach_id_col}, id
        """

        c.execute(sql, (*old_ids, "%Portfolio%"))
        old_attachments = c.fetchall()

finally:
    old.close()


# ======================================================================================
# LOAD NEW PROFILE / CURRENT PORTFOLIO STATE
# ======================================================================================

with pg.cursor(cursor_factory=RealDictCursor) as c:

    c.execute("""
        SELECT *
        FROM "Profile"
        WHERE "legacyId" = %s
    """, (OLD_PROFILE_ID,))

    new_profile = c.fetchone()

    if not new_profile:
        raise RuntimeError("NEW Profile with legacyId=91 not found")

    new_profile_id = new_profile["id"]

    c.execute("""
        SELECT *
        FROM "Portfolio"
        WHERE "profileId" = %s
        ORDER BY "legacyId", id
    """, (new_profile_id,))

    current_portfolios = c.fetchall()

    current_portfolio_ids = [r["id"] for r in current_portfolios]

    if current_portfolio_ids:
        placeholders = ",".join(["%s"] * len(current_portfolio_ids))

        c.execute(f"""
            SELECT *
            FROM "Attachment"
            WHERE "attachableId" IN ({placeholders})
            ORDER BY "legacyId", id
        """, current_portfolio_ids)

        current_attachments = c.fetchall()
    else:
        current_attachments = []


# ======================================================================================
# RESOLVE NEW ATTACHMENT TYPES
# ======================================================================================

with pg.cursor(cursor_factory=RealDictCursor) as c:
    c.execute('SELECT * FROM "AttachmentType" ORDER BY id')
    attachment_type_rows = c.fetchall()


def resolve_attachment_type(legacy_id):

    for r in attachment_type_rows:
        if r.get("legacyId") == legacy_id:
            return r["id"]

    if legacy_id == 7:
        needles = ["featured image", "featured"]
    elif legacy_id == 5:
        needles = ["portfolio gallery", "portfolio"]
    else:
        needles = []

    for r in attachment_type_rows:
        name = str(r.get("name") or "").lower().strip()

        if name in needles:
            return r["id"]

    for r in attachment_type_rows:
        name = str(r.get("name") or "").lower()

        if any(n in name for n in needles):
            return r["id"]

    return None


attachment_type_7 = resolve_attachment_type(7)
attachment_type_5 = resolve_attachment_type(5)

if not attachment_type_7:
    print("AttachmentType rows:")
    for r in attachment_type_rows:
        print(dict(r))
    raise RuntimeError("Cannot resolve NEW AttachmentType for old type 7")

if not attachment_type_5:
    print("WARNING: NEW AttachmentType for old type 5 could not be resolved.")
    print("Type-5 attachments will use attachmentTypeId=NULL.")


# ======================================================================================
# BUILD CURRENT / DUPLICATE MEDIA CANDIDATE INDEX
# ======================================================================================

current_by_legacy = {
    r["legacyId"]: r
    for r in current_attachments
    if r.get("legacyId") is not None
}

old_names = sorted({
    old_value(a, "doc_name", "docName")
    for a in old_attachments
    if old_value(a, "doc_name", "docName")
})

all_name_candidates = {}

with pg.cursor(cursor_factory=RealDictCursor) as c:
    for name in old_names:

        c.execute("""
            SELECT
                id,
                "legacyId",
                "docName",
                url,
                "publicId",
                bytes,
                "resourceType",
                format,
                extension,
                "mimeType",
                "attachableId"
            FROM "Attachment"
            WHERE "docName" = %s
              AND "publicId" IS NOT NULL
        """, (name,))

        all_name_candidates[name] = c.fetchall()


# ======================================================================================
# DETERMINE MEDIA SOURCE FOR EACH OLD ATTACHMENT
# ======================================================================================

source_plan = {}
unavailable = []
ambiguous = []

for old_a in old_attachments:

    legacy_attachment_id = int(old_a["id"])

    filename = old_value(
        old_a,
        "doc_name",
        "docName",
        default=f"attachment-{legacy_attachment_id}"
    )

    candidates = []

    # Highest confidence: exact current attachment legacyId.
    exact = current_by_legacy.get(legacy_attachment_id)

    if exact:
        exact_key = exact.get("publicId") or s3_key_from_url(exact.get("url"))

        head = s3_exists(s3, exact_key)

        if head:
            candidates.append({
                "confidence": 100,
                "source": "exact-current-legacy",
                **head,
            })

    # Recovery: same filename from any successfully migrated attachment.
    for row in all_name_candidates.get(filename, []):

        key = row.get("publicId") or s3_key_from_url(row.get("url"))

        head = s3_exists(s3, key)

        if head:
            candidates.append({
                "confidence": 50,
                "source": f'same-filename-legacy-{row.get("legacyId")}',
                **head,
            })

    # Remove duplicate keys.
    by_key = {}

    for candidate in candidates:
        existing = by_key.get(candidate["key"])

        if not existing or candidate["confidence"] > existing["confidence"]:
            by_key[candidate["key"]] = candidate

    candidates = list(by_key.values())

    if not candidates:
        source_plan[legacy_attachment_id] = None
        unavailable.append(legacy_attachment_id)
        continue

    exact_candidates = [
        x for x in candidates
        if x["confidence"] == 100
    ]

    if exact_candidates:
        chosen = exact_candidates[0]
    else:
        sizes = {x["bytes"] for x in candidates}

        # Same filename is accepted only if all found migrated copies
        # have the same byte size.
        if len(sizes) != 1:
            source_plan[legacy_attachment_id] = None
            ambiguous.append({
                "legacyId": legacy_attachment_id,
                "filename": filename,
                "candidates": candidates,
            })
            continue

        chosen = sorted(
            candidates,
            key=lambda x: x["key"]
        )[0]

    source_plan[legacy_attachment_id] = chosen


# ======================================================================================
# PREVIEW
# ======================================================================================

old_portfolio_map = {
    int(p["id"]): p
    for p in old_portfolios
}

print()
print("=" * 120)
print("MICHAELANGELO COMPLETE PORTFOLIO REBUILD")
print("=" * 120)

print("MODE                  :", "APPLY" if APPLY else "DRY RUN")
print("OLD PROFILE           :", OLD_PROFILE_ID)
print("NEW PROFILE ID        :", new_profile_id)
print("OLD PORTFOLIOS        :", len(old_portfolios))
print("OLD ATTACHMENTS       :", len(old_attachments))
print("CURRENT NEW PORTFOLIOS:", len(current_portfolios))
print("CURRENT ATTACHMENTS   :", len(current_attachments))
print("NEW TYPE-7 ID         :", attachment_type_7)
print("NEW TYPE-5 ID         :", attachment_type_5)

print()
print("-" * 120)
print("OLD PORTFOLIOS")
print("-" * 120)

for p in old_portfolios:

    legacy = int(p["id"])
    post_type = old_value(p, "post_type_id")
    title = old_value(p, "title")

    print(
        f"Portfolio {legacy:<5} "
        f"type={post_type!s:<3} "
        f"{'VIDEO' if post_type == 5 else 'GALLERY' if post_type == 4 else 'OTHER':<8} "
        f"title={title!r}"
    )

    for a in old_attachments:

        aid = int(a["id"])

        if int(old_value(a, old_attach_id_col)) != legacy:
            continue

        atype = old_value(a, "attachment_type_id")
        filename = old_value(a, "doc_name", "docName")

        source = source_plan.get(aid)

        if source:
            source_text = (
                f'RECOVERABLE bytes={source["bytes"]} '
                f'source={source["source"]}'
            )
        else:
            source_text = "SOURCE_MEDIA_UNAVAILABLE"

        print(
            f"   attachment={aid:<5} "
            f"type={atype!s:<3} "
            f"name={filename!r} "
            f"{source_text}"
        )


print()
print("-" * 120)
print("SUMMARY")
print("-" * 120)

print("Recoverable attachments:",
      sum(1 for x in source_plan.values() if x))

print("Unavailable attachments:", unavailable)

if ambiguous:
    print("Ambiguous attachments:")
    for row in ambiguous:
        print(row)

if len(old_portfolios) != 14:
    raise RuntimeError(
        f"Safety stop: expected 14 old Portfolios, got {len(old_portfolios)}"
    )

if len(old_attachments) != 15:
    raise RuntimeError(
        f"Safety stop: expected 15 old Portfolio attachments, got {len(old_attachments)}"
    )


# ======================================================================================
# DRY RUN STOPS HERE
# ======================================================================================

if not APPLY:

    print()
    print("=" * 120)
    print("DRY RUN — NOTHING CHANGED")
    print("=" * 120)

    pg.rollback()
    pg.close()
    sys.exit(0)


# ======================================================================================
# BACKUP CURRENT DATABASE STATE
# ======================================================================================

timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")

backup_dir = Path("migration_backups")
backup_dir.mkdir(parents=True, exist_ok=True)

backup_path = backup_dir / (
    f"michaelangelo_portfolio_before_rebuild_{timestamp}.json"
)

backup_payload = {
    "profile": dict(new_profile),
    "portfolios": [dict(x) for x in current_portfolios],
    "attachments": [dict(x) for x in current_attachments],
}

backup_path.write_text(
    json.dumps(
        backup_payload,
        indent=2,
        default=str
    )
)

print()
print("Local DB backup:", backup_path)


# ======================================================================================
# STAGE EVERY RECOVERABLE FILE BEFORE DELETION
# ======================================================================================

stage_prefix = (
    f"vbizme/migration-backup/"
    f"profile-{OLD_PROFILE_ID}/"
    f"{timestamp}"
)

staged = {}

print()
print("=" * 120)
print("STAGING RECOVERABLE MEDIA")
print("=" * 120)

for old_a in old_attachments:

    aid = int(old_a["id"])
    source = source_plan.get(aid)

    if not source:
        print(f"{aid}: SKIP — source unavailable")
        continue

    filename = old_value(
        old_a,
        "doc_name",
        "docName",
        default=f"attachment-{aid}"
    )

    stage_key = (
        f"{stage_prefix}/"
        f"{aid}-{safe_filename(filename)}"
    )

    s3.copy_object(
        Bucket=BUCKET,
        CopySource={
            "Bucket": BUCKET,
            "Key": source["key"],
        },
        Key=stage_key,
    )

    head = s3.head_object(
        Bucket=BUCKET,
        Key=stage_key,
    )

    if head["ContentLength"] != source["bytes"]:
        raise RuntimeError(
            f"Staging byte-size mismatch for attachment {aid}"
        )

    staged[aid] = {
        "key": stage_key,
        "bytes": head["ContentLength"],
    }

    print(
        f"{aid}: staged "
        f"{source['key']} -> {stage_key} "
        f"({head['ContentLength']} bytes)"
    )


# ======================================================================================
# COLLECT OLD S3 KEYS TO DELETE AFTER SUCCESS
# ======================================================================================

old_s3_keys = set()

for a in current_attachments:

    key = a.get("publicId") or s3_key_from_url(a.get("url"))

    if key:
        old_s3_keys.add(key)

# Do NOT delete arbitrary Portfolio imageUrl/attachmentUrl objects here.
# Some historical Portfolio fields may point at unrelated/shared S3 objects.
# Only delete S3 keys backed by this user's actual Attachment rows.


# ======================================================================================
# REBUILD POSTGRESQL + NEW S3 DESTINATIONS
# ======================================================================================

new_portfolio_ids = {}

try:

    with pg.cursor(cursor_factory=RealDictCursor) as c:

        print()
        print("=" * 120)
        print("DELETING CURRENT MICHAELANGELO PORTFOLIO DATABASE ROWS")
        print("=" * 120)

        if current_portfolio_ids:

            placeholders = ",".join(
                ["%s"] * len(current_portfolio_ids)
            )

            c.execute(
                f'''
                DELETE FROM "Attachment"
                WHERE "attachableId" IN ({placeholders})
                ''',
                current_portfolio_ids
            )

            print("Deleted Attachment rows:", c.rowcount)

        c.execute("""
            DELETE FROM "Portfolio"
            WHERE "profileId" = %s
        """, (new_profile_id,))

        print("Deleted Portfolio rows:", c.rowcount)


        # ------------------------------------------------------------------
        # Create Portfolios
        # ------------------------------------------------------------------

        print()
        print("=" * 120)
        print("CREATING PORTFOLIOS")
        print("=" * 120)

        for index, old_p in enumerate(old_portfolios):

            legacy_id = int(old_p["id"])
            pid = new_id()

            new_portfolio_ids[legacy_id] = pid

            title = old_value(old_p, "title")
            description = old_value(old_p, "description")

            status = old_value(
                old_p,
                "status",
                default=1
            )

            try:
                status = int(status)
            except Exception:
                status = 1

            post_type_id = old_value(
                old_p,
                "post_type_id",
                default=4
            )

            try:
                post_type_id = int(post_type_id)
            except Exception:
                post_type_id = 4

            sort_order = old_value(
                old_p,
                "sort_order",
                "sortOrder",
                default=index
            )

            try:
                sort_order = int(sort_order or 0)
            except Exception:
                sort_order = index

            old_url = old_value(old_p, "url")

            created_at = old_value(
                old_p,
                "created_at",
                "createdAt"
            ) or datetime.utcnow()

            updated_at = old_value(
                old_p,
                "updated_at",
                "updatedAt"
            ) or created_at

            c.execute("""
                INSERT INTO "Portfolio" (
                    id,
                    "legacyId",
                    "legacyPostTypeId",
                    "profileId",
                    title,
                    description,
                    status,
                    "sortOrder",
                    url,
                    "imageUrl",
                    "attachmentUrl",
                    "attachmentName",
                    "createdAt",
                    "updatedAt"
                )
                VALUES (
                    %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, NULL, NULL, NULL,
                    %s, %s
                )
            """, (
                pid,
                legacy_id,
                post_type_id,
                new_profile_id,
                title,
                description,
                status,
                sort_order,
                old_url,
                created_at,
                updated_at,
            ))

            print(
                f"Created Portfolio "
                f"{legacy_id} -> {pid} "
                f"type={post_type_id}"
            )


        # ------------------------------------------------------------------
        # Create attachments + copy S3
        # ------------------------------------------------------------------

        print()
        print("=" * 120)
        print("CREATING ATTACHMENTS / MEDIA")
        print("=" * 120)

        portfolio_media = {
            legacy: {
                "featured": None,
                "secondary": None,
            }
            for legacy in new_portfolio_ids
        }

        used_target_keys = set()

        for old_a in old_attachments:

            legacy_attachment_id = int(old_a["id"])

            old_portfolio_id = int(
                old_value(old_a, old_attach_id_col)
            )

            new_portfolio_id = new_portfolio_ids[
                old_portfolio_id
            ]

            filename = old_value(
                old_a,
                "doc_name",
                "docName",
                default=f"attachment-{legacy_attachment_id}"
            )

            attachment_type_legacy = old_value(
                old_a,
                "attachment_type_id"
            )

            try:
                attachment_type_legacy = int(
                    attachment_type_legacy
                )
            except Exception:
                attachment_type_legacy = None

            if attachment_type_legacy == 7:
                attachment_type_id = attachment_type_7
            elif attachment_type_legacy == 5:
                attachment_type_id = attachment_type_5
            else:
                attachment_type_id = None

            resource_type, fmt, extension, mime_type = ext_info(
                filename
            )

            created_at = old_value(
                old_a,
                "created_at",
                "createdAt"
            ) or datetime.utcnow()

            updated_at = old_value(
                old_a,
                "updated_at",
                "updatedAt"
            ) or created_at

            final_url = None
            final_key = None
            final_bytes = None

            stage = staged.get(legacy_attachment_id)

            if stage:

                clean_name = safe_filename(filename)

                target_key = (
                    f"vbizme/portfolio/"
                    f"{new_portfolio_id}/"
                    f"{clean_name}"
                )

                # Prevent key collision inside the same Portfolio.
                if target_key in used_target_keys:
                    target_key = (
                        f"vbizme/portfolio/"
                        f"{new_portfolio_id}/"
                        f"{legacy_attachment_id}-"
                        f"{clean_name}"
                    )

                used_target_keys.add(target_key)

                s3.copy_object(
                    Bucket=BUCKET,
                    CopySource={
                        "Bucket": BUCKET,
                        "Key": stage["key"],
                    },
                    Key=target_key,
                    ContentType=mime_type or "application/octet-stream",
                    MetadataDirective="REPLACE",
                )

                head = s3.head_object(
                    Bucket=BUCKET,
                    Key=target_key,
                )

                if head["ContentLength"] != stage["bytes"]:
                    raise RuntimeError(
                        f"Final S3 byte-size mismatch "
                        f"for attachment {legacy_attachment_id}"
                    )

                final_key = target_key
                final_bytes = head["ContentLength"]

                final_url = (
                    f"https://{BUCKET}."
                    f"s3.{REGION}.amazonaws.com/"
                    f"{target_key}"
                )

            attachment_id = new_id()

            c.execute("""
                INSERT INTO "Attachment" (
                    id,
                    "legacyId",
                    "attachmentTypeId",
                    "attachableType",
                    "attachableId",
                    "profileId",
                    "postId",
                    "docName",
                    url,
                    "publicId",
                    "resourceType",
                    format,
                    bytes,
                    extension,
                    "mimeType",
                    "createdAt",
                    "updatedAt"
                )
                VALUES (
                    %s, %s, %s,
                    %s, %s, %s,
                    NULL,
                    %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s
                )
            """, (
                attachment_id,
                legacy_attachment_id,
                attachment_type_id,
                r"App\Models\Portfolio",
                new_portfolio_id,
                new_profile_id,
                filename,
                final_url,
                final_key,
                resource_type,
                fmt,
                final_bytes,
                extension,
                mime_type,
                created_at,
                updated_at,
            ))

            if attachment_type_legacy == 7 and final_url:
                portfolio_media[old_portfolio_id]["featured"] = {
                    "url": final_url,
                    "name": filename,
                }

            if attachment_type_legacy == 5 and final_url:
                portfolio_media[old_portfolio_id]["secondary"] = {
                    "url": final_url,
                    "name": filename,
                }

            status_text = (
                f"S3={final_key}"
                if final_key
                else "SOURCE_MEDIA_UNAVAILABLE"
            )

            print(
                f"Attachment {legacy_attachment_id} "
                f"type={attachment_type_legacy} "
                f"Portfolio={old_portfolio_id} "
                f"{status_text}"
            )


        # ------------------------------------------------------------------
        # Apply Featured / Secondary media to Portfolio
        # ------------------------------------------------------------------

        print()
        print("=" * 120)
        print("UPDATING PORTFOLIO MEDIA FIELDS")
        print("=" * 120)

        for legacy_portfolio_id, data in portfolio_media.items():

            featured = data["featured"]
            secondary = data["secondary"]

            image_url = (
                featured["url"]
                if featured
                else None
            )

            attachment_url = (
                secondary["url"]
                if secondary
                else None
            )

            attachment_name = (
                secondary["name"]
                if secondary
                else None
            )

            c.execute("""
                UPDATE "Portfolio"
                SET
                    "imageUrl" = %s,
                    "attachmentUrl" = %s,
                    "attachmentName" = %s,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE id = %s
            """, (
                image_url,
                attachment_url,
                attachment_name,
                new_portfolio_ids[legacy_portfolio_id],
            ))

            print(
                f"Portfolio {legacy_portfolio_id}: "
                f"featured={'YES' if image_url else 'NO'} "
                f"secondary={'YES' if attachment_url else 'NO'}"
            )


        # ------------------------------------------------------------------
        # Final database safety audit before COMMIT
        # ------------------------------------------------------------------

        c.execute("""
            SELECT COUNT(*) AS n
            FROM "Portfolio"
            WHERE "profileId" = %s
        """, (new_profile_id,))

        portfolio_count = c.fetchone()["n"]

        c.execute("""
            SELECT COUNT(*) AS n
            FROM "Attachment" a
            JOIN "Portfolio" p
              ON p.id = a."attachableId"
            WHERE p."profileId" = %s
        """, (new_profile_id,))

        attachment_count = c.fetchone()["n"]

        if portfolio_count != len(old_portfolios):
            raise RuntimeError(
                f"Portfolio count mismatch: "
                f"{portfolio_count} != {len(old_portfolios)}"
            )

        if attachment_count != len(old_attachments):
            raise RuntimeError(
                f"Attachment count mismatch: "
                f"{attachment_count} != {len(old_attachments)}"
            )

        c.execute("""
            SELECT "legacyId", "legacyPostTypeId", title
            FROM "Portfolio"
            WHERE "profileId" = %s
            ORDER BY "legacyId"
        """, (new_profile_id,))

        type_audit = c.fetchall()

        print()
        print("=" * 120)
        print("TYPE AUDIT")
        print("=" * 120)

        for row in type_audit:
            print(dict(row))

        pg.commit()


except Exception:
    pg.rollback()
    print()
    print("DATABASE TRANSACTION ROLLED BACK")
    raise


# ======================================================================================
# DELETE OLD CURRENT S3 OBJECTS ONLY AFTER SUCCESSFUL DB COMMIT
# ======================================================================================

new_target_keys = set()

with pg.cursor(cursor_factory=RealDictCursor) as c:

    c.execute("""
        SELECT a."publicId"
        FROM "Attachment" a
        JOIN "Portfolio" p
          ON p.id = a."attachableId"
        WHERE p."profileId" = %s
          AND a."publicId" IS NOT NULL
    """, (new_profile_id,))

    for r in c.fetchall():
        if r["publicId"]:
            new_target_keys.add(r["publicId"])


delete_keys = sorted(
    old_s3_keys - new_target_keys
)

print()
print("=" * 120)
print("REMOVING OLD MICHAELANGELO S3 OBJECT REFERENCES")
print("=" * 120)

for key in delete_keys:

    # Never delete staged backup during rebuild.
    if key.startswith(stage_prefix):
        continue

    try:
        s3.delete_object(
            Bucket=BUCKET,
            Key=key
        )

        print("DELETED:", key)

    except Exception as e:
        print(
            "WARNING: unable to delete old key:",
            key,
            type(e).__name__,
            str(e)
        )


# ======================================================================================
# FINAL AUDIT
# ======================================================================================

with pg.cursor(cursor_factory=RealDictCursor) as c:

    c.execute("""
        SELECT
            p.id,
            p."legacyId",
            p."legacyPostTypeId",
            p.title,
            p."imageUrl",
            p."attachmentUrl",
            p."attachmentName",
            COUNT(a.id) AS attachment_count
        FROM "Portfolio" p
        LEFT JOIN "Attachment" a
          ON a."attachableId" = p.id
        WHERE p."profileId" = %s
        GROUP BY
            p.id,
            p."legacyId",
            p."legacyPostTypeId",
            p.title,
            p."imageUrl",
            p."attachmentUrl",
            p."attachmentName"
        ORDER BY p."legacyId"
    """, (new_profile_id,))

    rows = c.fetchall()


print()
print("=" * 120)
print("FINAL MICHAELANGELO PORTFOLIO AUDIT")
print("=" * 120)

for row in rows:

    type_name = (
        "gallery"
        if row["legacyPostTypeId"] == 4
        else "video"
        if row["legacyPostTypeId"] == 5
        else f'type-{row["legacyPostTypeId"]}'
    )

    print(
        f'{row["legacyId"]} | '
        f'{type_name:<8} | '
        f'{row["title"]!r:<30} | '
        f'attachments={row["attachment_count"]} | '
        f'featured={"YES" if row["imageUrl"] else "NO"} | '
        f'secondary={"YES" if row["attachmentUrl"] else "NO"}'
    )


print()
print("OLD PORTFOLIOS       :", len(old_portfolios))
print("NEW PORTFOLIOS       :", len(rows))
print("OLD ATTACHMENTS      :", len(old_attachments))
print("UNAVAILABLE MEDIA    :", unavailable)
print("STAGED BACKUP PREFIX :", stage_prefix)
print("LOCAL DB BACKUP      :", backup_path)

print()
print("=" * 120)
print("REBUILD COMMITTED SUCCESSFULLY")
print("=" * 120)

pg.close()
