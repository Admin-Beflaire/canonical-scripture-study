UPDATE release_selection SET current_release_id = 'ix-release' WHERE singleton_id = 1 AND current_release_id IS NULL AND previous_release_id IS NULL;
