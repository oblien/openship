import {
  AppError,
  ResourceIdSchema,
  isRecord,
  isResourceOutput,
  parseInput,
  type ResourceOperationSchema,
  type ResourceOperations,
  type ChildResourceOperations,
  type ScopedOperations,
} from "@repo/contracts";
import { ApiError } from "./errors";
import type { HttpClient } from "./http";

interface ResourceRoute {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path(id: string, input?: unknown): string;
  inputLocation?: "path" | "query";
  envelope?: string;
  body?(id: string, input?: unknown): unknown;
  response?(body: unknown): unknown;
  /** Some existing HTTP endpoints use an error status for a valid operation result. */
  resultStatuses?: readonly number[];
}

/** HTTP adapts only paths and envelopes; native calls share the same contracts. */
export function createRemoteResourceOperations<S extends Record<string, ResourceOperationSchema>>(
  http: HttpClient,
  schemas: S,
  routes: { [K in keyof S]: ResourceRoute },
): ResourceOperations<S> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schemas).map(([name, spec]) => [
        name,
        async (value: string, command?: unknown) => {
          const id = parseInput(ResourceIdSchema, value);
          const input = spec.input
            ? parseInput(spec.input, command === undefined && spec.optionalInput ? {} : command)
            : undefined;
          const route = routes[name];
          if (!route)
            throw new AppError(`Missing route for ${name}`, 501, "CAPABILITY_UNAVAILABLE");
          const url = http.url(route.path(id, input));
          if (((route.method === "GET" && route.inputLocation !== "path") || route.inputLocation === "query") && isRecord(input)) {
            for (const [key, value] of Object.entries(input))
              if (value !== undefined) url.searchParams.set(key, String(value));
          }
          const body = route.body ? route.body(id, input) : input;
          const response = await http.request<unknown>(url.href, {
            method: route.method,
            ...(route.method !== "GET" &&
              route.inputLocation === undefined &&
              body !== undefined && { body: JSON.stringify(body) }),
          }).catch((error: unknown) => {
            if (error instanceof ApiError && route.resultStatuses?.includes(error.status) &&
                isResourceOutput(spec, error.body)) return error.body;
            throw error;
          });
          const data = route.response ? route.response(response) : route.envelope
            ? isRecord(response)
              ? response[route.envelope]
              : undefined
            : response;
          if (!isResourceOutput(spec, data))
            throw new ApiError(`Invalid ${name} response`, 502, response);
          return data;
        },
      ]),
    ),
  ) as ResourceOperations<S>;
}

export function createRemoteScopedOperations<S extends Record<string, ResourceOperationSchema>>(
  http: HttpClient,
  schemas: S,
  routes: { [K in keyof S]: Omit<ResourceRoute, "path" | "body"> & {
    path(input?: unknown): string;
    body?(input?: unknown): unknown;
  } },
): ScopedOperations<S> {
  const adapted = Object.fromEntries(Object.entries(routes).map(([name, route]) => [name, {
    ...route,
    path: (_id: string, input?: unknown) => route.path(input),
    ...(route.body && { body: (_id: string, input?: unknown) => route.body!(input) }),
  }])) as { [K in keyof S]: ResourceRoute };
  const operations = createRemoteResourceOperations(http, schemas, adapted);
  return Object.freeze(Object.fromEntries(Object.entries(operations).map(([name, operation]) => [
    name,
    (input?: unknown) => (operation as (id: string, input?: unknown) => Promise<unknown>)("*", input),
  ]))) as ScopedOperations<S>;
}

export function createRemoteChildResourceOperations<
  S extends Record<string, ResourceOperationSchema>,
>(
  http: HttpClient,
  schemas: S,
  routes: {
    [K in keyof S]: Omit<ResourceRoute, "path"> & {
      path(parentId: string, id: string, input?: unknown): string;
    };
  },
): ChildResourceOperations<S> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schemas).map(([name, spec]) => [
        name,
        async (parent: string, id: string, input?: unknown) => {
          const parentId = parseInput(ResourceIdSchema, parent);
          const route = routes[name];
          const operation = createRemoteResourceOperations(
            http,
            { call: spec },
            {
              call: {
                ...route,
                path: (childId, command) => route.path(parentId, childId, command),
              },
            },
          );
          return (operation.call as (id: string, input?: unknown) => Promise<unknown>)(id, input);
        },
      ]),
    ),
  ) as unknown as ChildResourceOperations<S>;
}
