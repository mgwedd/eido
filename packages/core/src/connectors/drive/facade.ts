import type { DriveClient } from "./client"
export function createDriveFacade(client: DriveClient) {
  return {
    drive_list_files: async (options: { pageToken?: string } = {}) => ({
      ...(await client.listFiles(options)),
      untrusted: true as const,
    }),
    drive_search_files: async (
      query: string,
      options: { pageToken?: string } = {}
    ) => ({
      ...(await client.searchFiles(query, options)),
      untrusted: true as const,
    }),
    drive_get_file_text: (fileId: string) => client.getFileText(fileId),
  }
}
