"""Builds ScopeDriver instances by source name, and manages the
background task that pumps a driver's stream() into the hub -- shared
by startup (main.py's lifespan) and the runtime source-switch endpoint
(api/routes.py) so both paths build/swap drivers identically.
"""
from __future__ import annotations

import asyncio
import logging

from app.hub import Hub
from app.scope.driver import ScopeDriver
from app.scope.mock import MockScopeDriver

logger = logging.getLogger(__name__)

SCOPE_SOURCES = ("mock", "hantek", "teensy")


def create_scope_driver(source: str) -> ScopeDriver:
    if source == "hantek":
        from app.scope.hantek1008.driver import HantekScopeDriver

        return HantekScopeDriver()
    if source == "teensy":
        from app.scope.teensydaq.driver import TeensyDaqDriver

        return TeensyDaqDriver()
    return MockScopeDriver()


async def pump_scope(hub: Hub, driver: ScopeDriver) -> None:
    """Assumes `driver` is already connected -- forwards its stream into
    the hub until cancelled. Connection happens explicitly by the
    caller (startup or a source switch) so this can be restarted against
    a freshly-connected driver without a redundant connect() call."""
    async for batch in driver.stream():
        await hub.publish_scope(batch)


async def switch_scope_source(state, source: str) -> dict:
    """Connects the new driver first; only swaps state.scope_driver and
    restarts the pump task if that succeeds, so a bad switch (hardware
    not present) never leaves the system with no active source."""
    if source not in SCOPE_SOURCES:
        return {
            "ok": False,
            "error": f"unknown source {source!r}, must be one of {SCOPE_SOURCES}",
        }

    new_driver = create_scope_driver(source)
    try:
        await new_driver.connect()
    except Exception as exc:
        logger.warning("Failed to connect scope source %r: %s", source, exc)
        return {"ok": False, "error": str(exc)}

    old_task = state.scope_task
    old_driver = state.scope_driver
    if old_task is not None:
        old_task.cancel()
        try:
            await old_task
        except asyncio.CancelledError:
            pass
    await old_driver.disconnect()

    state.scope_driver = new_driver
    state.scope_source = source
    state.scope_task = asyncio.create_task(pump_scope(state.hub, new_driver))
    logger.info("Scope source switched to %s", source)
    return {"ok": True, "source": source}
