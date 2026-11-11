UPDATE release_selection SET current_release_id = NULL WHERE singleton_id = 1 AND current_release_id = 'ix-release' AND previous_release_id IS NULL;
