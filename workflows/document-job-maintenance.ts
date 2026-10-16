import { getWorkflowMetadata, sleep } from 'workflow';
import { start } from 'workflow/api';
import { documentJobMaintenanceStep } from '@/lib/server/document-job-maintenance';

export async function documentJobMaintenance(
  previousRunId: string | null = null
): Promise<{ dispatched: number; failed: number }> {
  'use workflow';

  const runId = getWorkflowMetadata().workflowRunId;
  let acquired = false;
  let dispatched = 0;
  let failed = 0;

  for (let cycle = 0; cycle < 336; cycle++) {
    try {
      const result = await documentJobMaintenanceStep(
        runId,
        acquired ? null : previousRunId
      );
      if (!result.owned) return { dispatched, failed };
      acquired = true;
      dispatched += result.dispatched;
      failed += result.failed;
    } catch {
      // Exhausted step retries must not prevent the next durable check.
      failed++;
    }
    await sleep('30m');
  }

  await start(documentJobMaintenance, [runId], { deploymentId: 'latest' });
  return { dispatched, failed };
}
