import { createAdminClient } from '@/lib/server/admin';
import { getSession } from '@/lib/server/supabase';
import { decodeBase64 } from '@/utils/base64';

export interface UserDocumentReference {
  id: string;
  title: string;
  file_path: string;
  user_id: string;
}

function getReferenceCandidates(reference: string): string[] {
  const candidates = [reference];

  try {
    const decoded = decodeBase64(reference);
    if (decoded && decoded !== reference) candidates.push(decoded);
  } catch {
    // The reference may be a plain document id from an older link.
  }

  return [...new Set(candidates)];
}

/**
 * Resolve a document reference to the authenticated user's database record.
 * References may be the base64-encoded title used by existing chat links or
 * a document id used by newer links; Storage paths are always read from the
 * database record.
 */
export async function getUserDocumentByReference(
  reference: string
): Promise<UserDocumentReference | null> {
  const session = await getSession();
  if (!session || !reference) return null;

  const supabase = createAdminClient();
  const candidates = getReferenceCandidates(reference);

  for (const candidate of candidates) {
    const { data: byId, error: idError } = await supabase
      .from('user_documents')
      .select('id, title, file_path, user_id')
      .eq('user_id', session.sub)
      .eq('id', candidate)
      .maybeSingle();

    if (!idError && byId) return byId;
  }

  for (const candidate of candidates) {
    const { data: byTitle, error: titleError } = await supabase
      .from('user_documents')
      .select('id, title, file_path, user_id')
      .eq('user_id', session.sub)
      .eq('title', candidate)
      .maybeSingle();

    if (!titleError && byTitle) return byTitle;
  }

  return null;
}
