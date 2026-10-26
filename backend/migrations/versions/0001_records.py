"""Versioned document storage: logical entities validated by application schemas."""
from alembic import op
import sqlalchemy as sa

revision="0001"
down_revision=None
branch_labels=None
depends_on=None


def upgrade():
    bind=op.get_bind()
    if not sa.inspect(bind).has_table("records"):
        op.create_table("records",
            sa.Column("id",sa.String(),primary_key=True),
            sa.Column("kind",sa.String(),nullable=False),
            sa.Column("body",sa.Text(),nullable=False),
            sa.Column("revision",sa.Integer(),nullable=False),
            sa.Column("created_at",sa.String(),nullable=False),
            sa.Column("updated_at",sa.String(),nullable=False))
        op.create_index("ix_records_kind","records",["kind"])


def downgrade():
    op.drop_index("ix_records_kind",table_name="records")
    op.drop_table("records")
