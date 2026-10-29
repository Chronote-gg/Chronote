import { jest } from "@jest/globals";
export const createResponse = () => {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: new Map<string, string>(),
    set: jest.fn((name: string, value: string) => {
      response.headers.set(name, value);
      return response;
    }),
    status: jest.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: jest.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
    end: jest.fn(() => response),
  };
  return response;
};
