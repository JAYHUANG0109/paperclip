export type FolderKind = "routine" | "skill";

/**
 * Folder access scope (consolidated from the fork's category-folder model):
 * - "company": visible to every company member.
 * - "private": visible only to the creator + `sharedUserIds`.
 * - "team": visible only to the creator + members of `sharingTeams`.
 * Enforced server-side; a folder's scope gates both the folder AND its items.
 */
export type FolderScope = "company" | "team" | "private";

export interface Folder {
  id: string;
  companyId: string;
  kind: FolderKind;
  parentId: string | null;
  name: string;
  slug: string;
  systemKey: string | null;
  path: string;
  depth: number;
  color: string | null;
  position: number;
  /** Access scope. Defaults to "company". */
  scope: FolderScope;
  /** For scope="team": team names allowed to see/use this folder. */
  sharingTeams: string[];
  /** For scope="private": extra user ids (besides the creator) who may see it. */
  sharedUserIds: string[];
  /** Board user who created the folder (null for system/bundled folders). */
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderListItem extends Folder {
  itemCount: number;
}

export interface FolderListResult {
  kind: FolderKind;
  folders: FolderListItem[];
  allCount: number;
  unfiledCount: number;
}

export interface CreateFolderRequest {
  kind: FolderKind;
  parentId?: string | null;
  name: string;
  slug?: string | null;
  color?: string | null;
  position?: number | null;
  scope?: FolderScope;
  sharingTeams?: string[];
  /** For scope="private": extra user ids (besides the creator) who may see it. */
  sharedUserIds?: string[];
}

export interface UpdateFolderRequest {
  name?: string;
  slug?: string;
  color?: string | null;
  position?: number;
  scope?: FolderScope;
  sharingTeams?: string[];
  sharedUserIds?: string[];
}

export interface MoveFolderRequest {
  parentId?: string | null;
  position: number;
}

export interface EnsureMySkillFolderRequest {
  slug?: string | null;
}

export interface MoveFolderItemRequest {
  kind: FolderKind;
  itemId: string;
  folderId?: string | null;
}
