#!/usr/bin/env python3

import os
from dotenv import load_dotenv

load_dotenv()
import requests
import psycopg2

OLD_API = "https://app.vbizme.com/api"
PG_DSN = os.environ["DATABASE_URL"].split("?")[0]

pg = psycopg2.connect(PG_DSN)
cur = pg.cursor()

# Get every legacy profile that exists in the new DB
cur.execute("""
    SELECT id, "legacyId", slug
    FROM "Profile"
    WHERE "legacyId" IS NOT NULL
    ORDER BY "legacyId"
""")

profiles = cur.fetchall()

updated = 0
missing = 0

for new_profile_id, legacy_profile_id, slug in profiles:

    url = f"{OLD_API}/dynamic-section/Video%20Links"

    try:
        r = requests.get(
            url,
            params={"profile_id": legacy_profile_id},
            timeout=30,
            headers={
                "Accept": "application/json",
                "Referer": "https://app.vbizme.com/"
            }
        )

        if r.status_code != 200:
            continue

        payload = r.json()

        if isinstance(payload, dict):
            rows = payload.get("data", payload)
        else:
            rows = payload

        if isinstance(rows, dict):
            rows = rows.get("data", rows.get("items", []))

        if not isinstance(rows, list):
            continue

        for item in rows:

            legacy_post_id = item.get("id")

            custom_url = (
                item.get("general_info_url")
                or item.get("custom_url")
                or item.get("url")
                or item.get("external_url")
            )

            # Some Laravel responses put it here
            review_link = item.get("review_link")
            if not custom_url and isinstance(review_link, dict):
                custom_url = review_link.get("url")

            if not legacy_post_id or not custom_url:
                missing += 1
                continue

            cur.execute("""
                UPDATE "VideoLink"
                SET
                    url = %s,
                    "updatedAt" = NOW()
                WHERE "legacyPostId" = %s
                  AND "legacyPostTypeId" = 27
                  AND (
                      url IS NULL
                      OR BTRIM(url) = ''
                  )
            """, (custom_url, int(legacy_post_id)))

            if cur.rowcount:
                updated += cur.rowcount
                print(
                    f'UPDATED {legacy_post_id}: '
                    f'{item.get("title", "")} -> {custom_url}'
                )

    except Exception as e:
        print(f"ERROR profile {slug} ({legacy_profile_id}): {e}")

pg.commit()

print()
print(f"Updated VideoLink URLs: {updated}")
print(f"Rows with no URL returned: {missing}")

cur.close()
pg.close()
