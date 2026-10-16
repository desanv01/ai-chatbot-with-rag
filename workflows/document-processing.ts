import { getWorkflowMetadata, sleep } from 'workflow';
import {
  claimDocumentJobStep,
  submitDocumentParserStep,
  pollDocumentParserStep,
  stageDocumentPagesStep,
  prepareDocumentMetadataStep,
  indexDocumentPageStep,
  completeDocumentJobStep,
  failDocumentJobStep
} from '@/lib/server/document-processing-steps';

export async function documentProcessingWorkflow(
  jobId: string,
  generation: number
): Promise<{ status: 'inactive' | 'ready' | 'failed' }> {
  'use workflow';

  const runId = getWorkflowMetadata().workflowRunId;
  const claimed = await claimDocumentJobStep(jobId, generation, runId);
  if (!claimed) return { status: 'inactive' };

  try {
    await submitDocumentParserStep(jobId, generation, runId);
    let parserReady = false;
    for (let check = 0; check < 360; check++) {
      const status = await pollDocumentParserStep(jobId, generation, runId);
      if (status === 'success') {
        parserReady = true;
        break;
      }
      if (check < 359) await sleep('10s');
    }
    if (!parserReady) throw new Error('parser_timeout');

    const { totalPages } = await stageDocumentPagesStep(
      jobId,
      generation,
      runId
    );
    if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 2000) {
      throw new Error('parse_result_invalid');
    }
    await prepareDocumentMetadataStep(jobId, generation, runId);

    for (let firstPage = 1; firstPage <= totalPages; firstPage += 4) {
      const batch = await Promise.allSettled(
        Array.from(
          { length: Math.min(4, totalPages - firstPage + 1) },
          (_, offset) =>
            indexDocumentPageStep(jobId, generation, runId, firstPage + offset)
        )
      );
      const failed = batch.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }

    await completeDocumentJobStep(jobId, generation, runId);
    return { status: 'ready' };
  } catch (error) {
    const message = error instanceof Error ? error.message : null;
    const safeCode =
      (
        [
          'source_invalid',
          'parser_submission_unknown',
          'parser_failed',
          'parser_timeout',
          'parse_result_invalid',
          'metadata_failed',
          'indexing_failed',
          'workflow_interrupted'
        ] as const
      ).find((code) => code === message) ?? 'workflow_interrupted';
    await failDocumentJobStep(jobId, generation, runId, safeCode);
    return { status: 'failed' };
  }
}
