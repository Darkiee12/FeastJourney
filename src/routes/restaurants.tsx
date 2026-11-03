import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/restaurants")({ component: Outlet });
