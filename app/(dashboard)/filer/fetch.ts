import { cache } from 'react';
import { createServerSupabaseClient } from '@/lib/server/server';
import { getOwnedDocumentVersions } from '@/lib/server/document-versions';

export const fetchUserFilesData = cache(async () => {
  const supabase = await createServerSupabaseClient();

  const { data: userData, error } = await supabase
    .from('users')
    .select(
      `
      id,
      user_documents (
        id,
        title,
        created_at,
        total_pages,
        file_path,
        processing_status,
        processing_error
      )
    `
    )
    .order('created_at', {
      referencedTable: 'user_documents',
      ascending: false
    })
    .maybeSingle();

  if (error || !userData) {
    return null;
  }

  try {
    const documents = userData.user_documents || [];
    const versions = await getOwnedDocumentVersions(
      userData.id,
      documents.map((document) => document.id)
    );
    const versionsByDocumentId = new Map(
      versions.map((version) => [version.documentId, version])
    );

    return {
      userId: userData.id,
      userDocuments: documents.map((document) => {
        const version = versionsByDocumentId.get(document.id);
        return {
          ...document,
          versionNumber: version?.version ?? 1,
          versionSeriesId: version?.seriesId ?? null,
          isCurrentVersion: version?.isCurrent ?? true,
          versionDisplayName: version?.displayName ?? document.title
        };
      })
    };
  } catch {
    return null;
  }
});
