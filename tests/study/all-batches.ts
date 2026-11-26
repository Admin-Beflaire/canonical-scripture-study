import {study} from '../../services/study/src/coordinator.ts';

type Env = Parameters<typeof study>[0];
type Request = Parameters<typeof study>[1];

/** Calls study until no continuation is left, as the guidance tells a host to. */
export async function allBatches<Batch extends {continuation: string | null}>(
  env: Env,
  request: Request,
  max = 20,
) {
  const batches: Batch[] = [];
  let continuation: string | undefined;
  for (let i = 0; i < max; i++) {
    const batch = (await study(env, {
      ...request,
      ...(continuation ? {continuation} : {}),
    })) as unknown as Batch;
    batches.push(batch);
    if (!batch.continuation) return batches;
    continuation = batch.continuation;
  }
  throw new Error('Too many batches');
}
