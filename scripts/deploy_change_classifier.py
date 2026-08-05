"""
scripts/deploy_change_classifier.py

Change-aware deploy classification -- PURE (tidak menyentuh SSH), supaya
bisa dites langsung. Dipakai safe_deploy.py untuk memutuskan:
  - perlu `npm run build` atau tidak (frontend berubah?)
  - perlu `pm2 reload` atau tidak (backend berubah?)

Konservatif: kalau ada path yang tidak bisa diklasifikasi dgn pasti,
DIANGGAP mempengaruhi frontend DAN backend (fail-safe ke arah "build ulang
semuanya", bukan diam-diam skip sesuatu yang seharusnya di-deploy).
"""

FRONTEND_PREFIXES = ("frontend/",)
BACKEND_PREFIXES = ("backend/",)
# Path yang TIDAK PERNAH butuh build/reload apa pun kalau berubah SENDIRIAN.
DOCS_AND_TOOLING_PREFIXES = (
    "docs/",
    "scripts/",
    ".claude/",
    ".github/",
)
DOCS_AND_TOOLING_EXACT = (
    "CLAUDE.md",
    "BricKnowledge.MD",
    "README.md",
    ".gitignore",
    "CLAUDE.local.md.example",
)


def _matches_prefix(path: str, prefixes) -> bool:
    return any(path == p.rstrip("/") or path.startswith(p) for p in prefixes)


def classify_changed_paths(paths: "list[str]") -> dict:
    """
    Klasifikasi daftar path yang berubah (dari `git diff --name-only OLD..NEW`).

    Return:
      {
        "frontend_changed": bool,
        "backend_changed": bool,
        "docs_or_tooling_only": bool,   -- True HANYA kalau SEMUA path masuk kategori docs/tooling
        "unclassified_paths": [...],    -- path yang tidak cocok kategori mana pun -- fail-safe: dihitung sbg frontend+backend
      }
    """
    frontend_changed = False
    backend_changed = False
    unclassified = []

    if not paths:
        # Tidak ada perubahan file sama sekali (deploy kosong) -- tidak perlu build/reload apa pun.
        return {"frontend_changed": False, "backend_changed": False, "docs_or_tooling_only": True, "unclassified_paths": []}

    for raw in paths:
        p = raw.strip()
        if not p:
            continue
        if _matches_prefix(p, FRONTEND_PREFIXES):
            frontend_changed = True
            continue
        if _matches_prefix(p, BACKEND_PREFIXES):
            backend_changed = True
            continue
        if _matches_prefix(p, DOCS_AND_TOOLING_PREFIXES) or p in DOCS_AND_TOOLING_EXACT:
            continue
        # Root-level file yang tidak dikenali (mis. apps-script-*.js, deploy_*.py lama,
        # *.code-workspace) -- BUKAN bagian aplikasi yang di-build/reload, tapi juga
        # bukan "docs" resmi. Catat sbg unclassified TAPI TIDAK memaksa build/reload
        # (root-level script Python/Apps Script tidak pernah mempengaruhi frontend/
        # backend runtime -- beda dari file di dalam frontend//backend/ yang tidak
        # kebaca prefix, yang sudah pasti masuk kategori di atas duluan).
        unclassified.append(p)

    docs_or_tooling_only = not frontend_changed and not backend_changed

    return {
        "frontend_changed": frontend_changed,
        "backend_changed": backend_changed,
        "docs_or_tooling_only": docs_or_tooling_only,
        "unclassified_paths": unclassified,
    }
