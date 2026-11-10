"""Adapter declarations and declarative recipe resolution (synthetic adapters only)."""
import unittest

from css_preparation.adapters import AdapterDeclaration, AdapterRegistry, RecipeError

TEXT = AdapterDeclaration('synthetic-text', '1', frozenset({'synthetic/plain'}), frozenset({'source_text'}),
                          frozenset({'encoding'}), ('no annotations',))


def recipe(**overrides):
    base = {'recipe_version': 'preparation-recipe/1', 'id': 'recipe-a', 'revision': 'r1',
            'adapter': {'name': 'synthetic-text', 'method_version': '1'}, 'input_format': 'synthetic/plain',
            'parameters': {'encoding': 'utf-8'}, 'native_extent': {'units': ['u1']}, 'capabilities': ['source_text'],
            'dependencies': []}
    base.update(overrides)
    return base


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.registry = AdapterRegistry()
        self.registry.register(TEXT)

    def test_resolves_declared_adapter(self):
        self.assertIs(self.registry.resolve(recipe()), TEXT)
        with self.assertRaises(ValueError):
            self.registry.register(TEXT)

    def test_rejects_recipes_that_do_not_fit(self):
        cases = [recipe(adapter={'name': 'synthetic-text', 'method_version': '2'}), recipe(input_format='synthetic/xml'),
                 recipe(capabilities=['word_index']), recipe(parameters={'script': 'run'}), recipe(credentials='x'),
                 recipe(recipe_version='preparation-recipe/0'), recipe(id='../escape')]
        for case in cases:
            with self.assertRaises(RecipeError, msg=str(case)):
                self.registry.resolve(case)

    def test_recipe_partition_units_are_declarative_data(self):
        units = [{'unit_id': 'acquire-1', 'kind': 'acquire', 'native_extent': {}, 'depends_on': []},
                 {'unit_id': 'prepare-u1', 'kind': 'prepare', 'native_extent': {'units': ['u1']},
                  'depends_on': ['acquire-1']},
                 {'unit_id': 'quality', 'kind': 'quality', 'native_extent': {'units': ['u1']},
                  'depends_on': ['prepare-u1'], 'required_capabilities': ['source_text']}]
        self.assertIs(self.registry.resolve(recipe(manifest_revision='m1', units=units)), TEXT)
        bad = [recipe(units=[]), recipe(units=[{**units[0], 'kind': 'deploy'}]),
               recipe(units=[{**units[0], 'script': 'run'}]), recipe(units=[{'unit_id': 'x', 'kind': 'prepare'}]),
               recipe(manifest_revision='../m')]
        for case in bad:
            with self.assertRaises(RecipeError, msg=str(case)):
                self.registry.resolve(case)


if __name__ == '__main__':
    unittest.main()
