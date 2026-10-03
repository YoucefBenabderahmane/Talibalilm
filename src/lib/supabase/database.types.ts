/**
 * Database types.
 *
 * Hand-written to match `supabase/migrations/`, because no Supabase project is
 * connected yet. Once one is, `npm run db:types` regenerates this file from
 * the live schema and that output wins — do not edit it by hand after that.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = 'student' | 'instructor' | 'admin';
export type AppLocale = 'fr' | 'en';

export type CourseLevel = 'all' | 'beginner' | 'intermediate' | 'advanced';
export type CourseFormat = 'presentiel' | 'visio' | 'hybride';
export type CourseStatus = 'draft' | 'published' | 'archived';
export type LessonType = 'video' | 'text' | 'live' | 'quiz' | 'assignment';
export type VideoProvider = 'bunny' | 'youtube' | 'drive' | 'r2' | 'none';
export type MembershipStatus = 'active' | 'expired' | 'cancelled';
export type ProgressStatus = 'not_started' | 'in_progress' | 'completed';

export type DeliveryMode = 'presentiel' | 'online';
export type CursusKind = 'module' | 'approfondi';
export type ProductKind = 'module' | 'cursus';
export type CatalogStatus = 'draft' | 'published' | 'archived';
export type EventPhase = 'upcoming' | 'ongoing' | 'finished';
export type EntitlementScope = 'course' | 'cursus' | 'site';
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'cancelled';
export type PaymentRoute = 'paypal' | 'office' | 'free';
export type PackPricing = 'sum' | 'fixed' | 'percent';
export type PaypalEnvironment = 'sandbox' | 'live';
export type LiveStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export type LiveRole = 'host' | 'participant';
export type JoinState = 'pending' | 'approved' | 'rejected';

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string;
          phone: string | null;
          civility: string | null;
          first_name: string;
          last_name: string;
          phone_landline: string | null;
          birth_date: string | null;
          address: string;
          postal_code: string;
          city: string;
          department: string;
          avatar_key: string | null;
          locale: AppLocale;
          role: UserRole;
          reviewed_at: string | null;
          approved_at: string | null;
          anonymised_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name?: string;
          phone?: string | null;
          civility?: string | null;
          first_name?: string;
          last_name?: string;
          phone_landline?: string | null;
          birth_date?: string | null;
          address?: string;
          postal_code?: string;
          city?: string;
          department?: string;
          avatar_key?: string | null;
          locale?: AppLocale;
          role?: UserRole;
          approved_at?: string | null;
          anonymised_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        // `role` is deliberately absent: `authenticated` has no column grant
        // for it, so a client-side update including it fails at the database.
        // Role changes go through an admin action using the service-role
        // client. Leaving it out of the type stops the mistake at compile time
        // as well as at runtime.
        Update: {
          full_name?: string;
          phone?: string | null;
          civility?: string | null;
          first_name?: string;
          last_name?: string;
          phone_landline?: string | null;
          birth_date?: string | null;
          address?: string;
          postal_code?: string;
          city?: string;
          department?: string;
          avatar_key?: string | null;
          locale?: AppLocale;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
            isOneToOne: true;
          },
        ];
      };
      site_settings: {
        Row: {
          id: boolean;
          announcement_text: string;
          announcement_href: string;
          announcement_enabled: boolean;
          facebook: string;
          instagram: string;
          tiktok: string;
          youtube: string;
          whatsapp: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['site_settings']['Row']>;
        Update: Partial<Database['public']['Tables']['site_settings']['Row']>;
        Relationships: [];
      };
      contact_messages: {
        Row: {
          id: string;
          name: string;
          email: string;
          subject: string;
          body: string;
          handled_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database['public']['Tables']['contact_messages']['Row']> & {
          name: string;
          email: string;
          body: string;
        };
        Update: Partial<Database['public']['Tables']['contact_messages']['Row']>;
        Relationships: [];
      };
      events: {
        Row: {
          id: string;
          title: string;
          title_ar: string;
          excerpt: string;
          body: string;
          image_url: string | null;
          starts_at: string | null;
          location: string;
          href: string;
          status: CatalogStatus;
          phase: EventPhase;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['events']['Row']> & { title: string };
        Update: Partial<Database['public']['Tables']['events']['Row']>;
        Relationships: [];
      };
      reviews: {
        Row: {
          id: string;
          author_name: string;
          author_context: string;
          quote: string;
          rating: number;
          avatar_url: string | null;
          status: CatalogStatus;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['reviews']['Row']> & {
          author_name: string;
          quote: string;
        };
        Update: Partial<Database['public']['Tables']['reviews']['Row']>;
        Relationships: [];
      };
      courses: {
        Row: {
          id: string;
          slug: string;
          title: string;
          subtitle: string;
          description: string;
          title_ar: string;
          cover_url: string | null;
          tone: string;
          category: string;
          level: CourseLevel;
          format: CourseFormat;
          language: string;
          instructor_id: string | null;
          status: CourseStatus;
          published_at: string | null;
          display_order: number;
          schedule: string;
          duration_weeks: number;
          objectives: Json;
          department: string;
          department_body: string;
          requirements: Json;
          highlights: Json;
          gallery: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database['public']['Tables']['courses']['Row']> & {
          slug: string;
          title: string;
        };
        Update: Partial<Database['public']['Tables']['courses']['Row']>;
        Relationships: [
          {
            foreignKeyName: 'courses_instructor_id_fkey';
            columns: ['instructor_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      modules: {
        Row: {
          id: string;
          course_id: string;
          title: string;
          position: number;
          created_at: string;
          updated_at: string;
        };
        Insert: { id?: string; course_id: string; title: string; position?: number };
        Update: { title?: string; position?: number };
        Relationships: [
          {
            foreignKeyName: 'modules_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
        ];
      };
      lessons: {
        Row: {
          id: string;
          module_id: string;
          title: string;
          slug: string;
          type: LessonType;
          position: number;
          duration_seconds: number;
          is_preview: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          module_id: string;
          title: string;
          slug: string;
          type?: LessonType;
          position?: number;
          duration_seconds?: number;
          is_preview?: boolean;
        };
        Update: {
          title?: string;
          slug?: string;
          type?: LessonType;
          position?: number;
          duration_seconds?: number;
          is_preview?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'lessons_module_id_fkey';
            columns: ['module_id'];
            isOneToOne: false;
            referencedRelation: 'modules';
            referencedColumns: ['id'];
          },
        ];
      };
      // The gated half. A non-member's select returns zero rows — there is no
      // request shape that yields `content` or `video_id`.
      lesson_content: {
        Row: {
          lesson_id: string;
          content: string;
          video_provider: VideoProvider;
          video_id: string | null;
          video_bytes: number;
          video_uploaded_at: string | null;
          video_expires_at: string | null;
          attachments: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          lesson_id: string;
          content?: string;
          video_provider?: VideoProvider;
          video_id?: string | null;
          attachments?: Json;
        };
        Update: {
          content?: string;
          video_provider?: VideoProvider;
          video_id?: string | null;
          video_bytes?: number;
          video_uploaded_at?: string | null;
          video_expires_at?: string | null;
          attachments?: Json;
        };
        Relationships: [
          {
            foreignKeyName: 'lesson_content_lesson_id_fkey';
            columns: ['lesson_id'];
            isOneToOne: true;
            referencedRelation: 'lessons';
            referencedColumns: ['id'];
          },
        ];
      };
      entitlements: {
        Row: {
          id: string;
          user_id: string;
          scope: EntitlementScope;
          course_id: string | null;
          cursus_id: string | null;
          year_index: number;
          delivery: DeliveryMode;
          status: MembershipStatus;
          starts_at: string;
          expires_at: string;
          source_order_id: string | null;
          granted_by: string | null;
          note: string;
          created_at: string;
          updated_at: string;
        };
        // Writable shapes exist because the service role genuinely inserts
        // here after a verified payment. No `authenticated` grant does — see
        // the grants at the foot of the commerce migration.
        Insert: {
          user_id: string;
          scope: EntitlementScope;
          course_id?: string | null;
          cursus_id?: string | null;
          year_index?: number;
          delivery?: DeliveryMode;
          expires_at: string;
          starts_at?: string;
          source_order_id?: string | null;
          granted_by?: string | null;
          note?: string;
        };
        Update: {
          status?: MembershipStatus;
          expires_at?: string;
          note?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'entitlements_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'entitlements_cursus_id_fkey';
            columns: ['cursus_id'];
            isOneToOne: false;
            referencedRelation: 'cursus';
            referencedColumns: ['id'];
          },
        ];
      };
      app_errors: {
        Row: {
          id: string;
          at: string;
          route: string;
          digest: string;
          name: string;
          message: string;
          stack_head: string;
        };
        // No Insert or Update shape that means anything: the table carries no
        // write policy at all, and `record_app_error` is the only door.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      push_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent?: string | null;
        };
        Update: {
          p256dh?: string;
          auth?: string;
          user_agent?: string | null;
        };
        Relationships: [];
      };
      enrollments: {
        Row: {
          id: string;
          user_id: string;
          course_id: string;
          enrolled_at: string;
          last_accessed_at: string;
        };
        Insert: { user_id: string; course_id: string; last_accessed_at?: string };
        Update: { last_accessed_at?: string };
        Relationships: [
          {
            foreignKeyName: 'enrollments_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
        ];
      };
      lesson_progress: {
        Row: {
          id: string;
          user_id: string;
          lesson_id: string;
          status: ProgressStatus;
          seconds_watched: number;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          lesson_id: string;
          status?: ProgressStatus;
          seconds_watched?: number;
          completed_at?: string | null;
        };
        Update: {
          status?: ProgressStatus;
          seconds_watched?: number;
          completed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'lesson_progress_lesson_id_fkey';
            columns: ['lesson_id'];
            isOneToOne: false;
            referencedRelation: 'lessons';
            referencedColumns: ['id'];
          },
        ];
      };
      cursus: {
        Row: {
          id: string;
          slug: string;
          kind: CursusKind;
          title: string;
          subtitle: string;
          description: string;
          details: string;
          image_url: string | null;
          year_count: number;
          status: CatalogStatus;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          slug: string;
          kind: CursusKind;
          title: string;
          subtitle?: string;
          description?: string;
          details?: string;
          image_url?: string | null;
          year_count?: number;
          status?: CatalogStatus;
          display_order?: number;
        };
        Update: Partial<{
          slug: string;
          kind: CursusKind;
          title: string;
          subtitle: string;
          description: string;
          details: string;
          image_url: string | null;
          year_count: number;
          status: CatalogStatus;
          display_order: number;
        }>;
        Relationships: [];
      };
      cursus_courses: {
        Row: {
          cursus_id: string;
          course_id: string;
          delivery: DeliveryMode;
          year_index: number;
          position: number;
        };
        Insert: {
          cursus_id: string;
          course_id: string;
          delivery: DeliveryMode;
          year_index?: number;
          position?: number;
        };
        Update: Partial<{ year_index: number; position: number }>;
        Relationships: [
          {
            foreignKeyName: 'cursus_courses_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'cursus_courses_cursus_id_fkey';
            columns: ['cursus_id'];
            isOneToOne: false;
            referencedRelation: 'cursus';
            referencedColumns: ['id'];
          },
        ];
      };
      products: {
        Row: {
          id: string;
          kind: ProductKind;
          course_id: string | null;
          cursus_id: string | null;
          year_index: number;
          delivery: DeliveryMode;
          time_slot: string;
          schedule_label: string;
          hours_per_year: number | null;
          /** Tenths of an hour: "3h/semaine" is 30. */
          hours_per_week: number | null;
          language: string;
          price_cents: number;
          currency: string;
          duration_days: number;
          status: CatalogStatus;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          kind: ProductKind;
          course_id?: string | null;
          cursus_id?: string | null;
          year_index?: number;
          delivery: DeliveryMode;
          time_slot?: string;
          schedule_label?: string;
          hours_per_year?: number | null;
          hours_per_week?: number | null;
          language?: string;
          price_cents: number;
          currency?: string;
          duration_days?: number;
          status?: CatalogStatus;
          display_order?: number;
        };
        Update: Partial<{
          kind: ProductKind;
          course_id: string | null;
          cursus_id: string | null;
          year_index: number;
          delivery: DeliveryMode;
          time_slot: string;
          schedule_label: string;
          hours_per_year: number | null;
          hours_per_week: number | null;
          language: string;
          price_cents: number;
          currency: string;
          duration_days: number;
          status: CatalogStatus;
          display_order: number;
        }>;
        Relationships: [
          {
            foreignKeyName: 'products_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'products_cursus_id_fkey';
            columns: ['cursus_id'];
            isOneToOne: false;
            referencedRelation: 'cursus';
            referencedColumns: ['id'];
          },
        ];
      };
      packs: {
        Row: {
          id: string;
          slug: string;
          title: string;
          description: string;
          delivery: DeliveryMode;
          pricing: PackPricing;
          price_cents: number | null;
          percent_off: number | null;
          currency: string;
          status: CatalogStatus;
          starts_at: string | null;
          ends_at: string | null;
          max_redemptions: number | null;
          redeemed_count: number;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          slug: string;
          title: string;
          description?: string;
          delivery: DeliveryMode;
          pricing?: PackPricing;
          price_cents?: number | null;
          percent_off?: number | null;
          status?: CatalogStatus;
          starts_at?: string | null;
          ends_at?: string | null;
          max_redemptions?: number | null;
          display_order?: number;
        };
        Update: Partial<{
          slug: string;
          title: string;
          description: string;
          delivery: DeliveryMode;
          pricing: PackPricing;
          price_cents: number | null;
          percent_off: number | null;
          status: CatalogStatus;
          starts_at: string | null;
          ends_at: string | null;
          max_redemptions: number | null;
          display_order: number;
        }>;
        Relationships: [];
      };
      pack_items: {
        Row: {
          pack_id: string;
          product_id: string;
          is_free: boolean;
          position: number;
        };
        Insert: { pack_id: string; product_id: string; is_free?: boolean; position?: number };
        Update: Partial<{ is_free: boolean; position: number }>;
        Relationships: [
          {
            foreignKeyName: 'pack_items_pack_id_fkey';
            columns: ['pack_id'];
            isOneToOne: false;
            referencedRelation: 'packs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'pack_items_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
        ];
      };
      coupons: {
        Row: {
          id: string;
          code: string;
          percent_off: number | null;
          amount_off_cents: number | null;
          currency: string;
          max_redemptions: number | null;
          redeemed_count: number;
          expires_at: string | null;
          is_office: boolean;
          batch: string;
          note: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          code: string;
          percent_off?: number | null;
          amount_off_cents?: number | null;
          max_redemptions?: number | null;
          expires_at?: string | null;
          is_office?: boolean;
          batch?: string;
          note?: string;
          created_by?: string | null;
        };
        Update: Partial<{
          max_redemptions: number | null;
          expires_at: string | null;
          note: string;
        }>;
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          user_id: string;
          status: OrderStatus;
          route: PaymentRoute;
          delivery: DeliveryMode;
          subtotal_cents: number;
          discount_cents: number;
          total_cents: number;
          currency: string;
          coupon_id: string | null;
          pack_id: string | null;
          provider_order_id: string | null;
          provider_capture_id: string | null;
          paid_at: string | null;
          coupon_released_at: string | null;
          pack_released_at: string | null;
          status_reason: string;
          plan_size: number;
          paid_cents: number;
          payment_method: string | null;
          confirmation_sent_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // Service role only. `authenticated` holds SELECT and nothing else, so
        // a browser cannot name its own total.
        Insert: {
          id?: string;
          user_id: string;
          route: PaymentRoute;
          delivery: DeliveryMode;
          subtotal_cents: number;
          discount_cents?: number;
          total_cents: number;
          currency?: string;
          status?: OrderStatus;
          coupon_id?: string | null;
          pack_id?: string | null;
          provider_order_id?: string | null;
          plan_size?: number;
          paid_cents?: number;
          payment_method?: string | null;
        };
        Update: Partial<{
          status: OrderStatus;
          status_reason: string;
          provider_order_id: string | null;
          provider_capture_id: string | null;
          paid_at: string | null;
          confirmation_sent_at: string | null;
          paid_cents: number;
          payment_method: string | null;
        }>;
        Relationships: [];
      };
      order_corrections: {
        Row: {
          id: string;
          order_id: string;
          from_entitlement_id: string | null;
          from_label: string;
          to_label: string;
          to_course_id: string | null;
          to_cursus_id: string | null;
          to_year_index: number | null;
          to_delivery: DeliveryMode;
          reason: string;
          actor_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          order_id: string;
          from_entitlement_id?: string | null;
          from_label?: string;
          to_label?: string;
          to_course_id?: string | null;
          to_cursus_id?: string | null;
          to_year_index?: number | null;
          to_delivery: DeliveryMode;
          reason: string;
          actor_id?: string | null;
          created_at?: string;
        };
        Update: Partial<{ reason: string }>;
        Relationships: [];
      };
      admin_security: {
        Row: {
          user_id: string;
          pin_hash: string;
          pin_salt: string;
          failed_attempts: number;
          locked_until: string | null;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          pin_hash: string;
          pin_salt: string;
          failed_attempts?: number;
          locked_until?: string | null;
          updated_at?: string;
        };
        Update: Partial<{
          pin_hash: string;
          pin_salt: string;
          failed_attempts: number;
          locked_until: string | null;
          updated_at: string;
        }>;
        Relationships: [];
      };
      installments: {
        Row: {
          id: string;
          order_id: string;
          sequence: number;
          amount_cents: number;
          due_at: string;
          status: 'pending' | 'paid' | 'cancelled';
          provider_order_id: string | null;
          provider_capture_id: string | null;
          paid_at: string | null;
          coupon_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          order_id: string;
          sequence: number;
          amount_cents: number;
          due_at: string;
          status?: 'pending' | 'paid' | 'cancelled';
          provider_order_id?: string | null;
          provider_capture_id?: string | null;
          paid_at?: string | null;
          coupon_id?: string | null;
        };
        Update: Partial<{
          status: 'pending' | 'paid' | 'cancelled';
          provider_order_id: string | null;
          provider_capture_id: string | null;
          paid_at: string | null;
          coupon_id: string | null;
        }>;
        Relationships: [
          {
            foreignKeyName: 'installments_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
        ];
      };
      order_items: {
        Row: {
          id: string;
          order_id: string;
          product_id: string;
          kind: ProductKind;
          course_id: string | null;
          cursus_id: string | null;
          year_index: number;
          delivery: DeliveryMode;
          unit_price_cents: number;
          duration_days: number;
          is_free: boolean;
          title: string;
          time_slot: string;
          schedule_label: string;
        };
        Insert: {
          order_id: string;
          product_id: string;
          kind: ProductKind;
          course_id?: string | null;
          cursus_id?: string | null;
          year_index?: number;
          delivery: DeliveryMode;
          unit_price_cents: number;
          duration_days: number;
          is_free?: boolean;
          title?: string;
          time_slot?: string;
          schedule_label?: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'order_items_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'order_items_product_id_fkey';
            columns: ['product_id'];
            isOneToOne: false;
            referencedRelation: 'products';
            referencedColumns: ['id'];
          },
        ];
      };
      admin_audit: {
        Row: {
          id: string;
          actor_id: string | null;
          action: string;
          target_type: string;
          target_id: string;
          reason: string;
          detail: Json;
          created_at: string;
        };
        // Written only by the definer functions; no client insert exists.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      payment_settings: {
        Row: {
          id: boolean;
          environment: PaypalEnvironment;
          client_id: string;
          client_secret: string;
          webhook_id: string;
          merchant_email: string;
          currency: string;
          enabled: boolean;
          updated_by: string | null;
          updated_at: string;
        };
        // Service role only, and only from `src/lib/paypal`. Neither `anon`
        // nor `authenticated` holds any grant on this table, so an admin's
        // browser session cannot read the secret even though the admin is the
        // one who set it.
        Insert: never;
        Update: Partial<{
          environment: PaypalEnvironment;
          client_id: string;
          client_secret: string;
          webhook_id: string;
          merchant_email: string;
          currency: string;
          enabled: boolean;
          updated_by: string | null;
        }>;
        Relationships: [];
      };
      live_sessions: {
        Row: {
          id: string;
          course_id: string;
          class_id: string;
          title: string;
          description: string;
          host_id: string | null;
          room_token: string;
          status: LiveStatus;
          scheduled_at: string | null;
          started_at: string | null;
          ended_at: string | null;
          max_participants: number;
          recording_note: string;
          require_approval: boolean;
          chat_enabled: boolean;
          student_camera: boolean;
          student_screen: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          course_id: string;
          class_id: string;
          title: string;
          description?: string;
          host_id?: string | null;
          status?: LiveStatus;
          scheduled_at?: string | null;
          max_participants?: number;
          recording_note?: string;
        };
        Update: {
          class_id?: string;
          title?: string;
          description?: string;
          host_id?: string | null;
          status?: LiveStatus;
          scheduled_at?: string | null;
          started_at?: string | null;
          ended_at?: string | null;
          max_participants?: number;
          recording_note?: string;
          require_approval?: boolean;
          chat_enabled?: boolean;
          student_camera?: boolean;
          student_screen?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'live_sessions_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'live_sessions_class_fk';
            columns: ['course_id', 'class_id'];
            isOneToOne: false;
            referencedRelation: 'classes';
            referencedColumns: ['course_id', 'id'];
          },
        ];
      };
      live_participants: {
        Row: {
          id: string;
          session_id: string;
          user_id: string;
          role: LiveRole;
          joined_at: string;
          left_at: string | null;
          muted: boolean;
          camera_allowed: boolean;
          screen_allowed: boolean;
          banned_at: string | null;
        };
        Insert: { session_id: string; user_id: string; role?: LiveRole };
        Update: { left_at?: string | null };
        Relationships: [];
      };
      live_join_requests: {
        Row: {
          id: string;
          session_id: string;
          user_id: string;
          display_name: string;
          status: JoinState;
          requested_at: string;
          decided_at: string | null;
        };
        Insert: { session_id: string; user_id: string; display_name?: string };
        Update: { status?: JoinState; decided_at?: string | null };
        Relationships: [];
      };
      live_messages: {
        Row: {
          id: string;
          session_id: string;
          user_id: string;
          body: string;
          created_at: string;
        };
        Insert: { session_id: string; user_id: string; body: string };
        Update: never;
        Relationships: [];
      };
      live_board_ops: {
        Row: { id: number; session_id: string; op: Json; created_at: string };
        Insert: { session_id: string; op: Json };
        Update: never;
        Relationships: [];
      };
      live_slides: {
        Row: {
          id: string;
          session_id: string;
          /** Key inside the R2 bucket. Never a URL — a slide is only ever served signed. */
          storage_key: string;
          filename: string;
          mime_type: string;
          byte_size: number;
          display_order: number;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          session_id: string;
          storage_key: string;
          filename?: string;
          mime_type: string;
          byte_size: number;
          display_order?: number;
        };
        Update: { filename?: string; display_order?: number };
        Relationships: [
          {
            foreignKeyName: 'live_slides_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'live_sessions';
            referencedColumns: ['id'];
          },
        ];
      };
      classes: {
        Row: {
          id: string;
          course_id: string;
          name: string;
          schedule: string;
          position: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          course_id: string;
          name: string;
          schedule?: string;
          position?: number;
        };
        Update: {
          name?: string;
          schedule?: string;
          position?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'classes_course_id_fkey';
            columns: ['course_id'];
            isOneToOne: false;
            referencedRelation: 'courses';
            referencedColumns: ['id'];
          },
        ];
      };
      class_members: {
        Row: {
          class_id: string;
          course_id: string;
          user_id: string;
          joined_at: string;
        };
        Insert: {
          class_id: string;
          course_id: string;
          user_id: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'class_members_course_id_class_id_fkey';
            columns: ['course_id', 'class_id'];
            isOneToOne: false;
            referencedRelation: 'classes';
            referencedColumns: ['course_id', 'id'];
          },
          {
            foreignKeyName: 'class_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      user_role: {
        Args: { uid?: string };
        Returns: UserRole;
      };
      is_staff: {
        Args: { uid?: string };
        Returns: boolean;
      };
      is_admin: {
        Args: { uid?: string };
        Returns: boolean;
      };
      has_course_access: {
        Args: { cid: string; uid?: string };
        Returns: boolean;
      };
      has_lesson_access: {
        Args: { lid: string; uid?: string };
        Returns: boolean;
      };
      has_any_entitlement: {
        Args: { uid?: string };
        Returns: boolean;
      };
      grant_order_entitlements: {
        Args: { oid: string };
        Returns: number;
      };
      redeem_coupon: {
        Args: { coupon_code: string };
        Returns: string | null;
      };
      expire_entitlements: {
        Args: Record<never, never>;
        Returns: number;
      };
      release_coupon: {
        Args: { coupon_id: string };
        Returns: boolean;
      };
      claim_pack: {
        Args: { pack_id: string | null };
        Returns: boolean;
      };
      release_order_holds: {
        Args: { oid: string };
        Returns: boolean;
      };
      expire_pending_orders: {
        Args: { older_than?: string };
        Returns: number;
      };
      revoke_order_entitlements: {
        Args: { oid: string; reason?: string };
        Returns: number;
      };
      payment_settings_status: {
        Args: Record<never, never>;
        Returns: Json;
      };
      emails_for: {
        Args: { ids: string[] };
        Returns: { id: string; email: string }[];
      };
      admin_grant_entitlement: {
        Args: {
          target_user: string;
          target_scope: EntitlementScope;
          course_id: string | null;
          cursus_id: string | null;
          year_index: number;
          delivery: DeliveryMode;
          days: number;
          reason: string;
        };
        Returns: string;
      };
      admin_revoke_entitlement: {
        Args: { entitlement_id: string; reason: string };
        Returns: boolean;
      };
      admin_mark_reviewed: {
        Args: { uid: string };
        Returns: boolean;
      };
      lesson_video_total_bytes: {
        Args: Record<string, never>;
        Returns: number;
      };
      unreviewed_student_count: {
        Args: Record<string, never>;
        Returns: number;
      };
      is_approved: {
        Args: { uid?: string };
        Returns: boolean;
      };
      pending_student_count: {
        Args: Record<string, never>;
        Returns: number;
      };
      admin_set_approval: {
        Args: { uid: string; approve: boolean };
        Returns: string | null;
      };
      end_stale_live_sessions: {
        Args: { max_hours?: number };
        Returns: number;
      };
      unconfirmed_users: {
        Args: { older_than: string };
        Returns: { id: string; email: string; created_at: string }[];
      };
      admin_correct_order: {
        Args: {
          target_order: string;
          old_entitlement: string;
          new_course: string | null;
          new_cursus: string | null;
          new_year: number | null;
          reason: string;
        };
        Returns: string;
      };
      claim_due_installment_notices: {
        Args: Record<string, never>;
        Returns: {
          installment_id: string;
          order_id: string;
          user_id: string;
          kind: string;
          amount_cents: number;
          due_at: string;
        }[];
      };
      admin_generate_coupons: {
        Args: {
          quantity: number;
          percent_off: number | null;
          amount_off_cents: number | null;
          max_redemptions: number | null;
          is_office: boolean;
          batch: string;
          code_prefix: string;
          expires_at: string | null;
        };
        Returns: string[];
      };
      admin_void_coupon: {
        Args: { coupon_id: string; reason: string };
        Returns: boolean;
      };
      admin_delete_coupons: {
        Args: { ids: string[] };
        Returns: number;
      };
      claim_confirmation_email: {
        Args: { oid: string };
        Returns: boolean;
      };
      record_app_error: {
        Args: {
          p_route: string;
          p_digest: string;
          p_name: string;
          p_message: string;
          p_stack_head: string;
        };
        Returns: undefined;
      };
      rate_limit_hit: {
        Args: { bucket: string; max_hits: number; window_seconds: number };
        Returns: Json;
      };
      prune_rate_limits: {
        Args: Record<never, never>;
        Returns: number;
      };
      can_join_live: {
        Args: { session_id: string; uid?: string };
        Returns: boolean;
      };
      live_join: {
        Args: { session_id: string };
        Returns: string;
      };
      live_leave: {
        Args: { session_id: string };
        Returns: boolean;
      };
      live_decide_join: {
        Args: { request_id: string; admit: boolean };
        Returns: boolean;
      };
      can_read_slide: {
        Args: { key: string; uid?: string };
        Returns: boolean;
      };
      live_room_state: {
        Args: { session_id: string };
        /** null when the door is shut; otherwise what this caller may do in the room. */
        Returns: LiveRoomState | null;
      };
      live_set_participant: {
        Args: {
          target_session: string;
          target_user: string;
          set_muted?: boolean | null;
          set_camera?: boolean | null;
          set_screen?: boolean | null;
          set_banned?: boolean | null;
        };
        Returns: boolean;
      };
      admin_anonymise_user: {
        Args: { target_user: string; reason: string };
        Returns: boolean;
      };
    };
    Enums: {
      user_role: UserRole;
      app_locale: AppLocale;
      delivery_mode: DeliveryMode;
      cursus_kind: CursusKind;
      product_kind: ProductKind;
      catalog_status: CatalogStatus;
      event_phase: EventPhase;
      entitlement_scope: EntitlementScope;
      order_status: OrderStatus;
      payment_route: PaymentRoute;
      pack_pricing: PackPricing;
      paypal_environment: PaypalEnvironment;
      live_status: LiveStatus;
      live_role: LiveRole;
      join_state: JoinState;
    };
    CompositeTypes: Record<never, never>;
  };
}

export type Profile = Database['public']['Tables']['profiles']['Row'];
export type SiteSettingsRow = Database['public']['Tables']['site_settings']['Row'];
export type ContactMessageRow = Database['public']['Tables']['contact_messages']['Row'];
export type EventRow = Database['public']['Tables']['events']['Row'];
export type ReviewRow = Database['public']['Tables']['reviews']['Row'];
export type CourseRow = Database['public']['Tables']['courses']['Row'];
export type ModuleRow = Database['public']['Tables']['modules']['Row'];
export type LessonRow = Database['public']['Tables']['lessons']['Row'];
export type LessonContentRow = Database['public']['Tables']['lesson_content']['Row'];
export type EntitlementRow = Database['public']['Tables']['entitlements']['Row'];
export type CursusRow = Database['public']['Tables']['cursus']['Row'];
export type CursusCourseRow = Database['public']['Tables']['cursus_courses']['Row'];
export type ProductRow = Database['public']['Tables']['products']['Row'];
export type PackRow = Database['public']['Tables']['packs']['Row'];
export type PackItemRow = Database['public']['Tables']['pack_items']['Row'];
export type CouponRow = Database['public']['Tables']['coupons']['Row'];
export type OrderRow = Database['public']['Tables']['orders']['Row'];
export type OrderItemRow = Database['public']['Tables']['order_items']['Row'];
/** What one person may do in one classroom, as `live_room_state` reports it. */
export interface LiveRoomState {
  is_host: boolean;
  chat_enabled: boolean;
  require_approval: boolean;
  student_camera: boolean;
  student_screen: boolean;
  muted: boolean;
  camera_allowed: boolean;
  screen_allowed: boolean;
}

export type PaymentSettingsRow = Database['public']['Tables']['payment_settings']['Row'];
export type AdminAuditRow = Database['public']['Tables']['admin_audit']['Row'];
export type ProgressRow = Database['public']['Tables']['lesson_progress']['Row'];
