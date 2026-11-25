/** A build of Genesis from a named acquisition route, with the owner's admission decision. */
export const prepareGenesis = {
  request_key: 'p1',
  instruction: 'Prepare Genesis',
  steps: ['build' as const],
  inputs: [{kind: 'acquisition' as const, id: 'route-1'}],
  extent: {books: ['GEN']},
  capabilities: ['source_text'],
  constraints: {recipe: 'r1'},
  decision_refs: [
    {kind: 'admission' as const, ref: 'owner-decision:1', subject: 'route-1'},
  ],
};
