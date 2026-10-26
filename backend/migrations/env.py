from logging.config import fileConfig
from pathlib import Path
import os

from alembic import context
from sqlalchemy import create_engine, pool

config = context.config
if os.getenv("PLANNER_DATA_DIR"):
    config.set_main_option("sqlalchemy.url", "sqlite:///" + (Path(os.environ["PLANNER_DATA_DIR"])/"planner.db").as_posix())

if context.is_offline_mode():
    context.configure(url=config.get_main_option("sqlalchemy.url"),literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    engine=create_engine(config.get_main_option("sqlalchemy.url"),poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
