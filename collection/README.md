# Collection configuration

Source manifests live in `manifests/`; preparation recipes live in `recipes/`.

The optional character-of-God statement is supplied at `character-of-god-statement.json`, only
with a name and version the owner has separately approved. It records the format
(`character-statement/1`), name, version, status, an approval reference, the Scripture basis as
reader references and the wording as a list of paragraphs. The statement checks conclusions;
it is not an interpretive premise. Merging the file does not select it: a Maintenance task
fetches and builds it with the owner's admission and statement decisions.

A new version changes the file and adds a manifest (with the file's SHA-256 and size), a fetch
recipe and a build recipe under new revision names; the earlier manifest and recipes are removed
because their pinned file no longer exists on `main`.
