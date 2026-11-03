import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/dishes")({ component: Outlet });
