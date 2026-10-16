import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { start } from 'workflow/api';
import { createAdminClient } from '@/lib/server/admin';
import { documentJobMaintenance } from '@/workflows/document-job-maintenance';

type MaintenanceLease = {
  singleton: boolean;
  run_id: string | null;
  lease_until: string | null;
};

type MaintenanceDatabase = {
  public: {
    Tables: {
      document_job_maintenance: {
        Row: MaintenanceLease;
        Insert: MaintenanceLease;
        Update: Partial<MaintenanceLease>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};

export async function ensureDocumentJobMaintenance(): Promise<void> {
  try {
    const client = createAdminClient({
      requestTimeoutMs: 30_000
    }) as unknown as SupabaseClient<MaintenanceDatabase>;
    const { data, error } = await client
      .from('document_job_maintenance')
      .select('run_id,lease_until')
      .eq('singleton', true)
      .single();
    if (error || !data) throw new Error('Maintenance state unavailable.');

    const leaseUntil =
      data.lease_until === null ? null : Date.parse(data.lease_until);
    if (leaseUntil !== null && !Number.isFinite(leaseUntil)) {
      throw new Error('Maintenance state unavailable.');
    }
    if (data.run_id !== null && leaseUntil !== null && leaseUntil > Date.now())
      return;

    // Concurrent starters are fenced by the maintenance claim RPC.
    await start(documentJobMaintenance, [null]);
  } catch {
    throw new Error(
      'Document processing maintenance is unavailable. Please retry later.'
    );
  }
}
