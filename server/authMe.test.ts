/**
 * server/authMe.test.ts
 * S2: auth.me is discriminated on authType so the client can gate on
 * mustChangePassword for clinic staff without ever seeing passwordHash or
 * token_version — this is a runtime check of that (see also
 * clinicUsers.migration.test.ts's static-source check on routers.ts).
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./_core/sdk";

function callerFor(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
  };
  return appRouter.createCaller(ctx);
}

describe("auth.me", () => {
  it("returns null when there is no authenticated session", async () => {
    const result = await callerFor(null).auth.me();
    expect(result).toBeNull();
  });

  it("returns the owner shape for an owner OAuth session", async () => {
    const owner: AuthenticatedUser = {
      id: "1",
      openId: "owner-open-id",
      name: "Owner",
      email: "owner@example.com",
      loginMethod: "google",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };

    const result = await callerFor(owner).auth.me();

    expect(result).toEqual({
      authType: "owner",
      id: "1",
      name: "Owner",
      email: "owner@example.com",
      role: "admin",
    });
  });

  it("W/X: returns the clinic shape with mustChangePassword, and never passwordHash or token_version", async () => {
    const clinicSession: AuthenticatedUser = {
      id: "33333333-3333-3333-3333-333333333333",
      openId: "clinic_nurse.jane",
      name: "nurse.jane",
      email: null,
      loginMethod: "password",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
      clinicUser: {
        clinicUserId: "22222222-2222-2222-2222-222222222222",
        username: "nurse.jane",
        name: "Jane Nurse",
        email: "jane@example.com",
        department: "PT",
        role: "staff",
        mustChangePassword: true,
      },
    };

    const result = await callerFor(clinicSession).auth.me();

    expect(result).toEqual({
      authType: "clinic",
      id: "33333333-3333-3333-3333-333333333333",
      clinicUserId: "22222222-2222-2222-2222-222222222222",
      username: "nurse.jane",
      name: "Jane Nurse",
      email: "jane@example.com",
      department: "PT",
      role: "staff",
      mustChangePassword: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/passwordHash/i);
    expect(serialized).not.toMatch(/tokenVersion/i);
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("tokenVersion");
  });

  it("mustChangePassword=false surfaces correctly once the forced gate has been cleared", async () => {
    const clinicSession: AuthenticatedUser = {
      id: "33333333-3333-3333-3333-333333333333",
      openId: "clinic_nurse.jane",
      name: "nurse.jane",
      email: null,
      loginMethod: "password",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
      clinicUser: {
        clinicUserId: "22222222-2222-2222-2222-222222222222",
        username: "nurse.jane",
        name: "Jane Nurse",
        email: "jane@example.com",
        department: "PT",
        role: "staff",
        mustChangePassword: false,
      },
    };

    const result = await callerFor(clinicSession).auth.me();

    expect(result).toMatchObject({ authType: "clinic", mustChangePassword: false });
  });
});
