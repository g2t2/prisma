import { Cluster, PrismaDefinitionClass } from 'prisma-yml'
import { GraphQLClient } from 'graphql-request'

const SERVICE_NAME = 'prisma-temporary-introspection-service'
const SERVICE_STAGE = 'prisma-temporary-test-stage'
const SERVICE_SECRET = 'prisma-instrospection-secret'

// Removed DB Client interface. This is not polymorphic to other db clients.
export class PrismaDBClient {
  cluster: Cluster
  client: GraphQLClient
  definition: PrismaDefinitionClass

  constructor(definition: PrismaDefinitionClass) {
    this.definition = definition
  }

  async query(query: string, variables: string[] = []): Promise<any> {
    const finalQuery = this.replace(query, variables)
    const databases = await this.getDatabases()

    if (!databases || !databases[0]) {
      throw new Error(`Prisma Config doesn't have any database connection`)
    }

    return this.client.request(
      `
      mutation executeRaw($query: String! $database: PrismaDatabase) {
        rows: executeRaw(
          database: $database
          query: $query
        )
      }
    `,
      {
        query: finalQuery,
        database: databases[0],
      },
    )
  }

  async getDatabases(): Promise<string[]> {
    const result = await this.client.request<any>(
      `{
      __type(name: "PrismaDatabase") {
        kind
        enumValues {
          name
        }
      }
    }`,
    )

    if (result && result.__type && result.__type.enumValues) {
      return result.__type.enumValues.map(v => v.name)
    }

    return []
  }

  replace(query: string, variables: string[] = []): string {
    let queryString = query

    for (const [index, variable] of variables.entries()) {
      const regex = new RegExp(`\\$${index + 1}`, 'g')
      queryString = queryString.replace(regex, `'${variable}'`)
    }

    return queryString
  }

  async connect() {
    const cluster = await this.definition.getCluster()
    if (!cluster) {
      throw new Error('Could not get Prisma server for introspection')
    }
    await this.cluster
      .request(
        `mutation($input: AddProjectInput!) {
          addProject(input: $input) {
            clientMutationId
          }
        }`,
        {
          input: {
            name: SERVICE_NAME,
            stage: SERVICE_STAGE,
            secrets: [SERVICE_SECRET],
          },
        },
      )
      .then(res => res.json())

    const endpoint = this.cluster.getApiEndpoint(SERVICE_NAME, SERVICE_STAGE)
    const secretsBackup = this.definition.secrets
    this.definition.secrets = [SERVICE_SECRET]
    const token = this.definition.getToken(SERVICE_NAME, SERVICE_STAGE)
    this.definition.secrets = secretsBackup
    this.client = new GraphQLClient(endpoint, {
      headers: token
        ? {
            Authorization: `Bearer ${token}`,
          }
        : {},
    })
  }

  async end() {
    try {
      await this.cluster
        .request(
          `mutation($input: DeleteProjectInput!) {
            deleteProject(input: $input) {
              clientMutationId
            }
          }`,
          {
            input: {
              name: SERVICE_NAME,
              stage: SERVICE_STAGE,
            },
          },
        )
        .then(res => res.json())
    } catch (e) {
      // ignore error
    }
  }
}
