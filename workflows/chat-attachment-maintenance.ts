import { getWorkflowMetadata, sleep } from 'workflow';
import { start } from 'workflow/api';
import { maintenanceStep } from '@/lib/server/chat-attachment-cleanup';

export async function chatAttachmentMaintenance(
  previousRunId: string | null = null
): Promise<{ removed: number; failed: number }> {
  'use workflow';

  const currentRunId = getWorkflowMetadata().workflowRunId;
  let removed = 0;
  let failed = 0;
  let acquired = false;
  for (let iteration = 0; iteration < 336; iteration++) {
    try {
      const result = await maintenanceStep(
        currentRunId,
        acquired ? null : previousRunId
      );
      if (!result.owned) return { removed, failed };
      acquired = true;
      removed += result.removed;
      failed += result.failed;
    } catch {
      // Exhausting one step's bounded retries must not strand the DB outbox.
      // Recheck after the normal durable sleep rather than spinning on an outage.
      failed++;
    }
    await sleep('30m');
  }

  // Enqueue the successor without waiting for its long-running return value.
  await start(chatAttachmentMaintenance, [currentRunId]);
  return { removed, failed };
}
