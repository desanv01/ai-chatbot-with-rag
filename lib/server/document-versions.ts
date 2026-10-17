import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/server/server';

type DocumentRow = {
  id: string;
  user_id: string;
  title: string;
  processing_status: string | null;
};

type SeriesRow = {
  id: string;
  user_id: string;
  display_name: string;
  active_document_id: string | null;
  created_at: string;
};

type MembershipRow = {
  document_id: string;
  series_id: string;
  user_id: string;
  version: number;
  created_at: string;
};

type ReplacementCandidateRow = {
  job_id: string;
  user_id: string;
  target_document_id: string;
  candidate_document_id: string;
  series_id: string;
  expected_active_document_id: string;
  promoted_at: string | null;
};

type ReadTable<Row> = {
  Row: Row;
  Insert: Row;
  Update: Partial<Row>;
  Relationships: [];
};

// Narrow read contracts while the authoritative generated schema is updated.
type VersionsDatabase = {
  public: {
    Tables: {
      user_documents: ReadTable<DocumentRow>;
      document_series: ReadTable<SeriesRow>;
      document_series_members: ReadTable<MembershipRow>;
      document_replacement_candidates: ReadTable<ReplacementCandidateRow>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};

type VersionsClient = SupabaseClient<VersionsDatabase>;

export interface OwnedDocumentVersion {
  documentId: string;
  seriesId: string;
  version: number;
  isCurrent: boolean;
  displayName: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalUuid(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !UUID_PATTERN.test(value)
  ) {
    throw new Error('Invalid document identifier.');
  }
  return value.toLowerCase();
}

async function requireOwner(userId: string): Promise<{
  userId: string;
  client: VersionsClient;
}> {
  const owner = canonicalUuid(userId);
  const client = await createServerSupabaseClient();
  const { data, error } = await client.auth.getUser();
  if (error || data.user?.id.toLowerCase() !== owner) {
    throw new Error('Document access denied.');
  }
  return { userId: owner, client: client as unknown as VersionsClient };
}

export async function getOwnedReplacementTarget(
  userId: string,
  documentId: string
): Promise<{ id: string; title: string } | null> {
  try {
    const id = canonicalUuid(documentId);
    const owner = await requireOwner(userId);
    const { data: document, error: documentError } = await owner.client
      .from('user_documents')
      .select('id,user_id,title,processing_status')
      .eq('user_id', owner.userId)
      .eq('id', id)
      .maybeSingle();
    if (documentError) throw new Error('Document is unavailable.');
    if (
      document?.user_id !== owner.userId ||
      document.id !== id ||
      document.processing_status !== 'ready'
    ) {
      return null;
    }
    const { data: member, error: memberError } = await owner.client
      .from('document_series_members')
      .select('document_id,series_id,user_id')
      .eq('user_id', owner.userId)
      .eq('document_id', id)
      .maybeSingle();
    if (memberError) throw new Error('Document version is unavailable.');
    if (member) {
      if (member.user_id !== owner.userId || member.document_id !== id)
        return null;
      const { data: series, error: seriesError } = await owner.client
        .from('document_series')
        .select('id,user_id,active_document_id')
        .eq('user_id', owner.userId)
        .eq('id', member.series_id)
        .maybeSingle();
      if (seriesError) throw new Error('Document version is unavailable.');
      if (
        series?.user_id !== owner.userId ||
        series.id !== member.series_id ||
        series.active_document_id !== id
      ) {
        return null;
      }
    }
    return { id: document.id, title: document.title };
  } catch {
    throw new Error('Unable to check the document replacement target.');
  }
}

export async function getOwnedDocumentVersions(
  userId: string,
  documentIds: string[]
): Promise<OwnedDocumentVersion[]> {
  try {
    if (!Array.isArray(documentIds) || documentIds.length > 1000) {
      throw new Error('Invalid document identifiers.');
    }
    const ids = [...new Set(documentIds.map(canonicalUuid))];
    const owner = await requireOwner(userId);
    if (ids.length === 0) return [];
    const { data: members, error: memberError } = await owner.client
      .from('document_series_members')
      .select('document_id,series_id,user_id,version')
      .eq('user_id', owner.userId)
      .in('document_id', ids);
    if (memberError) throw new Error('Document versions are unavailable.');
    const requestedIds = new Set(ids);
    const ownedMembers = (members ?? []).filter(
      (member) =>
        member.user_id === owner.userId && requestedIds.has(member.document_id)
    );
    if (ownedMembers.length === 0) return [];
    const seriesIds = [
      ...new Set(ownedMembers.map((member) => member.series_id))
    ];
    const { data: seriesRows, error: seriesError } = await owner.client
      .from('document_series')
      .select('id,user_id,display_name,active_document_id')
      .eq('user_id', owner.userId)
      .in('id', seriesIds);
    if (seriesError) throw new Error('Document versions are unavailable.');
    const seriesById = new Map(
      (seriesRows ?? [])
        .filter((series) => series.user_id === owner.userId)
        .map((series) => [series.id, series])
    );
    return ownedMembers.flatMap((member) => {
      const series = seriesById.get(member.series_id);
      if (!series) return [];
      return [
        {
          documentId: member.document_id,
          seriesId: series.id,
          version: member.version,
          isCurrent: series.active_document_id === member.document_id,
          displayName: series.display_name
        }
      ];
    });
  } catch {
    throw new Error('Unable to load document versions.');
  }
}

export async function isOwnedVersionedDocument(
  userId: string,
  documentId: string
): Promise<boolean> {
  try {
    const id = canonicalUuid(documentId);
    const owner = await requireOwner(userId);
    const { data, error } = await owner.client
      .from('document_series_members')
      .select('document_id,user_id')
      .eq('user_id', owner.userId)
      .eq('document_id', id)
      .maybeSingle();
    if (error) throw new Error('Document version is unavailable.');
    return data?.document_id === id && data.user_id === owner.userId;
  } catch {
    throw new Error('Unable to check document version membership.');
  }
}

export async function isOwnedReplacementReservation(
  userId: string,
  jobId: string,
  targetDocumentId: string,
  documentId: string
): Promise<boolean> {
  try {
    const job = canonicalUuid(jobId);
    const target = canonicalUuid(targetDocumentId);
    const document = canonicalUuid(documentId);
    const owner = await requireOwner(userId);
    const { data, error } = await owner.client
      .from('document_replacement_candidates')
      .select('job_id,user_id,target_document_id,candidate_document_id')
      .eq('user_id', owner.userId)
      .eq('job_id', job)
      .maybeSingle();
    if (error)
      throw new Error('Document replacement reservation is unavailable.');
    return (
      data?.user_id === owner.userId &&
      data.job_id === job &&
      data.target_document_id === target &&
      data.candidate_document_id === document
    );
  } catch {
    throw new Error('Unable to check the document replacement reservation.');
  }
}
