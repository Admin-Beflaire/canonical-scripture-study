"""Index size limits shared by builders, validators and the adapter."""

# One encoded-byte cap for postings pages, directory pages and the manifest (Data Indexes
# To-Be 0.6 §2). Platform's Workers fit measurement confirms or replaces this value.
PAGE_CAP = 16384
