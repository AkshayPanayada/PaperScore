# Host PaperScore on GitHub Pages

This ZIP contains the complete static website. Answer reading uses the bundled
augmented CNN. PDF reading and printed/handwritten roll-number OCR also run in
the browser using bundled assets. No backend, API key, npm installation or build
step is required for hosting.

## Publish the deployment ZIP

1. Create a GitHub repository, for example `PaperScore`, and clone it with GitHub
   Desktop or Git.
2. Extract **the contents** of `PaperScore_GitHub_Pages_Deploy.zip` into that
   repository. `index.html`, `.nojekyll`, `app.js`, `ocr-assets/` and
   `paperscore-assets/` must be at the repository root. Include hidden files.
3. Commit and push the extracted files to `main` using GitHub Desktop or Git.
   Do not upload the ZIP itself as the website. Use actual model files rather
   than Git LFS pointer files.
4. Open the repository's **Settings → Pages**. Under **Build and deployment**,
   choose **Deploy from a branch**, branch **main**, folder **/(root)**, then
   **Save**.
5. Wait for the Pages deployment to finish. Open the URL shown in Settings,
   normally `https://YOUR-USERNAME.github.io/PaperScore/`.

Keep `.nojekyll` in place so GitHub serves the prepared files directly. Asset and
worker URLs are relative to the application, supporting both repository URLs
such as `/PaperScore/` and a custom domain's root.

The largest bundled model is approximately 39 MiB. GitHub's browser uploader
limits individual files to 25 MiB, so use GitHub Desktop or Git to push the files.
All bundled files are below GitHub's regular Git per-file limit of 100 MiB.

Official instructions: [Configure the publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
and [GitHub file size limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github).

## Import the private roll roster

The supplied `PaperScore_Roll_Roster.csv` is delivered separately and is excluded
from this public deployment. After opening the site, use **Roll roster (CSV, kept
on this device)** to import it once in each browser. It remains in that browser's
local storage and helps resolve OCR suggestions without publishing the roster.

All supplied IDs remain eligible for recognition. The list includes TAs and
inactive accounts; membership does not establish a person's role or enrollment.
Unclear or conflicting readings require confirmation. The roster is a recognition
aid, not an attendance filter.

Publish only the extracted deployment files. Keep the roster, filled student
sheets, exported grades and training data out of the public repository.

## Grade a sheet

1. Save an answer key. Multi-option answers can use `A+C`.
2. Upload both JPEG/PNG pages together, in either order, or a two-page PDF.
   Both pages are required because the corrections section is on Page 2.
3. Check the roll-number crop and confirm or edit uncertain OCR suggestions.
4. Review corrections at the top. Enter each target question and check the
   replacement answer against its crop. Confirm the row. If rows target the
   same question, explicitly select the authoritative row. Mark cancelled or
   unused detected rows with a reason. Use **Add a missed correction** if needed.
5. Inspect the entire correction-section image, including apparently blank rows,
   and confirm the section. A clipped section requires a complete replacement
   Page 2. Confirmed corrections override the main answers; originals are retained.
6. Review uncertain main answers next. **Confirm all**, at the bottom, accepts
   the current main answer readings; correction and identity checks stay separate.
7. Save a completed result, or save progress and resume later. Export CSV copies
   of grades; exports include correction decisions and original CNN readings.

Re-uploading Page 2 resets its correction decisions. A changed Page 1 requires
another correction-section check to confirm that both pages belong together.

## Storage and local use

Photos and recognition stay in the browser. Results and imported rosters use
local storage; drafts include compressed review previews. Browser storage is
separate for each device and website origin. Clearing it removes saved progress.
There is no shared server gradebook. Export grades before changing domains or
clearing browser data.

Use a current browser with JavaScript and WebAssembly enabled. OCR model assets
load when needed, so the first nonblank handwritten field may take longer.
Manual roll entry remains available if OCR cannot read the field. Recognition
can miss marks; whole-section review and final confirmation remain necessary.

For local use, serve the extracted folder over HTTP, for example
`python3 -m http.server 8000`, and open `http://localhost:8000/`. Opening
`index.html` directly with `file://` does not support the required module loading.

`deployment-manifest.json` records the size and SHA-256 of every packaged file
except the manifest itself. Third-party licenses and model provenance are in
`ocr-assets/` and `paperscore-assets/`.
