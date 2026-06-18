# Levrage Campaign Runner

A no-build UI for running call campaigns by uploading a contacts sheet.

## Run it

Just open `index.html` in a browser — there's no build step.

Best run via a tiny local server (avoids browser file:// quirks):

```bash
cd /Users/chaitu/Desktop/auto-followup
python3 -m http.server 5173
# then open http://localhost:5173
```

## Use it

1. Paste your **API Bearer token** at the top and click **Save** (stored in your browser's localStorage).
2. **New Campaign** tab:
   - Fill name + source phone number.
   - Pick an **Agent** (loaded from `GET /agents`).
   - **Upload** a CSV / XLSX sheet of contacts (drag-drop or browse).
   - Choose the **Phone column** (auto-guessed).
   - Optionally set scheduling, retry config, and blackout periods.
   - **Launch Campaign** → `POST /campaigns`.
3. **Campaigns** tab: lists campaigns (`GET /campaigns`), filter by status,
   **Pause** / **Resume**, and click a row for full details (`GET /campaigns/{id}`).

## APIs wired up

| Action | Endpoint |
|---|---|
| Load agents | `GET /agents` |
| Create campaign | `POST /campaigns` |
| List campaigns | `GET /campaigns` |
| Campaign detail | `GET /campaigns/{id}` |
| Pause | `POST /campaigns/{id}/pause` |
| Resume | `POST /campaigns/{id}/resume` |

## Notes

- The whole sheet (minus parsing) is sent as the `contacts` array, so every column
  becomes a per-contact variable. The selected phone column is sent as `phone_column`.
- Max **2000** contacts per campaign (enforced before submit).
- **CORS:** the API must allow browser requests from your origin. If you see CORS
  errors in the console, the API needs to permit your origin, or you can put a thin
  proxy in front. The UI itself is correct.
