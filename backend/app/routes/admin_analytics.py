"""Admin Analytics API.

All aggregations run in SQL over ``usage_records`` — never loaded wholesale
into Python. No mock numbers: every metric is computed from real usage data.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import UsageRecord, User
from ..routes.deps import get_current_admin
from ..schemas.admin import (
    AiUsageBucket,
    AiUsageDaily,
    AiUsageResponse,
    AnalyticsPeriod,
    AnalyticsSummary,
    AnalyticsTotals,
)

router = APIRouter(prefix="/admin/analytics", tags=["admin-analytics"])

DAY_MS = 86_400_000
EPOCH_UTC = datetime(1970, 1, 1, tzinfo=timezone.utc)

# Columns for a grouped distribution query (group key + counts + tokens).
_DIST_AGGREGATES = (
    func.count(),
    func.coalesce(
        func.sum(case((UsageRecord.status == "success", 1), else_=0)), 0
    ),
    func.coalesce(
        func.sum(case((UsageRecord.status == "failed", 1), else_=0)), 0
    ),
    func.coalesce(func.sum(UsageRecord.total_tokens), 0),
)


def _parse_range(from_ms: int | None, to_ms: int | None) -> tuple[int | None, int | None]:
    if from_ms is not None and to_ms is not None and from_ms > to_ms:
        raise HTTPException(
            status_code=400, detail="'from' must not be after 'to'"
        )
    return from_ms, to_ms


def _range_conditions(from_ms: int | None, to_ms: int | None) -> list:
    conditions = []
    if from_ms is not None:
        conditions.append(UsageRecord.created_at >= from_ms)
    if to_ms is not None:
        conditions.append(UsageRecord.created_at <= to_ms)
    return conditions


def _token_totals(db: Session, conditions: list) -> tuple[int, int, int]:
    row = db.execute(
        select(
            func.coalesce(func.sum(UsageRecord.input_tokens), 0),
            func.coalesce(func.sum(UsageRecord.output_tokens), 0),
            func.coalesce(func.sum(UsageRecord.total_tokens), 0),
        ).where(*conditions)
    ).one()
    return int(row[0]), int(row[1]), int(row[2])


def _request_totals(db: Session, conditions: list) -> tuple[int, int, int]:
    total = db.scalar(select(func.count()).select_from(UsageRecord).where(*conditions)) or 0
    successful = (
        db.scalar(
            select(func.count())
            .select_from(UsageRecord)
            .where(UsageRecord.status == "success", *conditions)
        )
        or 0
    )
    return total, successful, total - successful


def _dist(db: Session, conditions: list, key_column) -> list:
    rows = db.execute(
        select(key_column, *_DIST_AGGREGATES)
        .where(*conditions)
        .group_by(key_column)
        .order_by(func.count().desc())
        .limit(50)
    ).all()
    return [
        AiUsageBucket(
            key=str(r[0]),
            requests=int(r[1]),
            successful=int(r[2]),
            failed=int(r[3]),
            total_tokens=int(r[4]),
        )
        for r in rows
    ]


def _today_start_ms() -> int:
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp() * 1000)


@router.get("/summary", response_model=AnalyticsSummary)
def analytics_summary(
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
    from_ms: int | None = Query(None, ge=0),
    to_ms: int | None = Query(None, ge=0),
):
    """Aggregate usage summary for the Admin Dashboard.

    ``requests_today`` is the count since the start of the current UTC day
    (independent of the optional date range). All other totals honor the
    optional ``from_ms``/``to_ms`` window.
    """
    from_ms, to_ms = _parse_range(from_ms, to_ms)
    conditions = _range_conditions(from_ms, to_ms)

    total_requests, successful, failed = _request_totals(db, conditions)
    active_users = (
        db.scalar(
            select(func.count(func.distinct(UsageRecord.user_id))).where(*conditions)
        )
        or 0
    )
    input_tokens, output_tokens, total_tokens = _token_totals(db, conditions)
    requests_today = (
        db.scalar(
            select(func.count())
            .select_from(UsageRecord)
            .where(UsageRecord.created_at >= _today_start_ms())
        )
        or 0
    )
    total_users = db.scalar(select(func.count()).select_from(User)) or 0

    return AnalyticsSummary(
        period=AnalyticsPeriod(from_ms=from_ms, to_ms=to_ms),
        totals=AnalyticsTotals(
            total_users=total_users,
            active_users=active_users,
            total_requests=total_requests,
            successful_requests=successful,
            failed_requests=failed,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            requests_today=requests_today,
        ),
    )


@router.get("/ai-usage", response_model=AiUsageResponse)
def ai_usage(
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
    from_ms: int | None = Query(None, ge=0),
    to_ms: int | None = Query(None, ge=0),
    provider: str | None = Query(None, max_length=50),
    model: str | None = Query(None, max_length=200),
):
    """AI usage analytics with SQL aggregation.

    Returns daily series, provider/model/status/request-type distributions,
    and totals, all filtered by the optional date range and provider/model.
    """
    from_ms, to_ms = _parse_range(from_ms, to_ms)
    conditions = _range_conditions(from_ms, to_ms)
    if provider:
        conditions.append(UsageRecord.provider == provider)
    if model:
        conditions.append(UsageRecord.model == model)

    day_expr = UsageRecord.created_at / DAY_MS
    daily_rows = db.execute(
        select(
            day_expr.label("day"),
            func.count().label("requests"),
            func.coalesce(
                func.sum(case((UsageRecord.status == "success", 1), else_=0)), 0
            ).label("successful"),
            func.coalesce(
                func.sum(case((UsageRecord.status == "failed", 1), else_=0)), 0
            ).label("failed"),
            func.coalesce(func.sum(UsageRecord.input_tokens), 0).label("input_tokens"),
            func.coalesce(func.sum(UsageRecord.output_tokens), 0).label("output_tokens"),
            func.coalesce(func.sum(UsageRecord.total_tokens), 0).label("total_tokens"),
        )
        .where(*conditions)
        .group_by(day_expr)
        .order_by(day_expr)
    ).all()
    series = [
        AiUsageDaily(
            date=(EPOCH_UTC + timedelta(days=int(r[0]))).date().isoformat(),
            requests=int(r[1]),
            successful=int(r[2]),
            failed=int(r[3]),
            input_tokens=int(r[4]),
            output_tokens=int(r[5]),
            total_tokens=int(r[6]),
        )
        for r in daily_rows
    ]

    total_requests, successful, failed = _request_totals(db, conditions)
    input_tokens, output_tokens, total_tokens = _token_totals(db, conditions)
    active_users = (
        db.scalar(
            select(func.count(func.distinct(UsageRecord.user_id))).where(*conditions)
        )
        or 0
    )

    return AiUsageResponse(
        period=AnalyticsPeriod(from_ms=from_ms, to_ms=to_ms),
        filters={
            "provider": provider,
            "model": model,
            "from_ms": from_ms,
            "to_ms": to_ms,
        },
        totals=AnalyticsTotals(
            total_users=db.scalar(select(func.count()).select_from(User)) or 0,
            active_users=active_users,
            total_requests=total_requests,
            successful_requests=successful,
            failed_requests=failed,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            requests_today=0,
        ),
        series=series,
        by_provider=_dist(db, conditions, UsageRecord.provider),
        by_model=_dist(db, conditions, UsageRecord.model),
        by_status=_dist(db, conditions, UsageRecord.status),
        by_request_type=_dist(db, conditions, UsageRecord.request_type),
    )
