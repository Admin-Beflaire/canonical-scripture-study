# Source manifests

Source manifests belong here. A manifest must retain the applicable admission and attribution basis. No source has been admitted by creation of this directory.

An acquire-only manifest states in `admission_record` what its fetch saves as the admission
record: `terms_basis`, `permitted_uses`, `restrictions` (exactly one storage rule among
them), `notices` (the first is the source's attribution), `both_hosts_eligible` and
`public_redistribution`. A STEPBible fetch recipe states the same block in
`parameters.admission_record`. Preparation saves the block as it stands and Control compares
it with the saved record, so changing it means the owner is asked for admission again.

`stepbible-data-5de0a47f35f0.json` records the pinned STEPBible-Data files used by the
STEPBible recipes, their licence basis and storage rule. The owner's admission decision is
given in the Maintenance Control task, not here.

`character-statement-0-2.json` pins the owner's statement file in this repository. It is the
only manifest whose source is a file of the public repository. Its storage rule records that
the admission allows public placement, which its terms basis grounds in the owner's
permission; every other acquire-only source stays unresolved for public redistribution.

B1 STEP language aids are listed in the pinned STEP inventory. Each also has a
single-file `stepdata-*.json` manifest with the URL and rights fields the existing
acquire-only runner needs. Third-party source bytes are never committed to public Git.
