import type { DriveClient } from "./client"
export function createDriveFacade(client: DriveClient) {
  return {
    drive_list_files: async () => ({
      ...(await client.listFiles()),
      untrusted: true as const,
    }),
    drive_search_files: async (query: string) => ({
      ...(await client.searchFiles(query)),
      untrusted: true as const,
    }),
    drive_get_file_text: (fileId: string) => client.getFileText(fileId),
  }
}
