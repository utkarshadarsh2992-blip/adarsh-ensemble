"""In-app action layer (Standard mode): turn a spoken/typed command into validated steps the phone executes.

Separate from the reasoning layer on purpose: nothing here calls a model, so reminders, alarms, timers, notes and
simple phone tasks work with no internet and no API key. Risky steps are marked and must be confirmed by the user.
"""
from .plan import handle, plan  # noqa: F401
