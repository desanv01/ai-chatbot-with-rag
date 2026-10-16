import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RetryableError } from 'workflow';
import { getRun, start } from 'workflow/api';
import type { JobStatus } from '@/lib/document-job-types';
import { createAdminClient } from '@/lib/server/admin';
import { documentProcessingWorkflow } from '@/workflows/document-processing';

type MaintenanceJob = {
  id: string;
  generation: number;
  run_id: string | null;
  status: JobStatus;
  created_at: string;
  updated_at: string;
};

type MaintenanceDatabase = {
  public: {
    Tables: {
      document_processing_jobs: {
        Row: MaintenanceJob;
        Insert: MaintenanceJob;
        Update: Partial<MaintenanceJob>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      claim_document_job_maintenance: {
        Args: { p_run_id: string; p_previous_run_id: string | null };
        Returns: boolean;
      };
      fail_document_job: {
        Args: {
          p_job_id: string;
          p_generation: number;
          p_run_id: string;
          p_error_code: 'workflow_interrupted';
        };
        Returns: boolean;
      };
    };
  };
};

export async function documentJobMaintenanceStep(
  runId: string,
  previousRunId: string | null
): Promise<{ owned: boolean; dispatched: number; failed: number }> {
  'use step';

  try {
    const client = createAdminClient({
      requestTimeoutMs: 30_000
    }) as unknown as SupabaseClient<MaintenanceDatabase>;
    const { data: owned, error: claimError } = await client.rpc(
      'claim_document_job_maintenance',
      { p_run_id: runId, p_previous_run_id: previousRunId }
    );
    if (claimError || typeof owned !== 'boolean') {
      throw new Error('Maintenance claim unavailable.');
    }
    if (!owned) return { owned: false, dispatched: 0, failed: 0 };

    const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const [queued, active] = await Promise.all([
      client
        .from('document_processing_jobs')
        .select('id,generation')
        .eq('status', 'queued')
        .is('run_id', null)
        .order('created_at', { ascending: true })
        .limit(5),
      client
        .from('document_processing_jobs')
        .select('id,generation,run_id')
        .in('status', ['queued', 'parsing', 'metadata', 'indexing'])
        .not('run_id', 'is', null)
        .lt('updated_at', staleBefore)
        .order('updated_at', { ascending: true })
        .limit(5)
    ]);
    if (queued.error || active.error || !queued.data || !active.data) {
      throw new Error('Maintenance jobs unavailable.');
    }

    // Never write run_id here: the processing claim fences duplicate deliveries.
    const dispatchResults = await Promise.all(
      queued.data.map(async (job) => {
        try {
          await start(documentProcessingWorkflow, [job.id, job.generation], {
            deploymentId: 'latest'
          });
          return true;
        } catch {
          return false;
        }
      })
    );

    const observationResults = await Promise.allSettled(
      active.data.map(async (job): Promise<number> => {
        if (job.run_id === null) return 0;
        let status: Awaited<ReturnType<typeof getRun>['status']>;
        try {
          status = await getRun(job.run_id).status;
        } catch {
          // Unknown infrastructure state is never evidence to change a job.
          return 1;
        }
        if (
          status !== 'failed' &&
          status !== 'cancelled' &&
          status !== 'completed'
        ) {
          return 0;
        }
        const { data: failed, error } = await client.rpc('fail_document_job', {
          p_job_id: job.id,
          p_generation: job.generation,
          p_run_id: job.run_id,
          p_error_code: 'workflow_interrupted'
        });
        if (error || typeof failed !== 'boolean') {
          throw new Error('Maintenance checkpoint unavailable.');
        }
        return failed ? 1 : 0;
      })
    );

    let observationFailures = 0;
    for (const result of observationResults) {
      if (result.status === 'rejected') {
        throw new Error('Maintenance checkpoint unavailable.');
      }
      observationFailures += result.value;
    }

    return {
      owned: true,
      dispatched: dispatchResults.filter(Boolean).length,
      failed:
        dispatchResults.filter((dispatched) => !dispatched).length +
        observationFailures
    };
  } catch {
    throw new RetryableError(
      'Document job maintenance is temporarily unavailable.',
      {
        retryAfter: '5m'
      }
    );
  }
}
