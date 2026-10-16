export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      chat_attachment_cleanup_jobs: {
        Row: {
          attempts: number
          completed_at: string | null
          last_error: string | null
          lease_expires_at: string | null
          lease_token: string | null
          next_attempt_at: string
          object_path: string
          queued_at: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          last_error?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          next_attempt_at?: string
          object_path: string
          queued_at?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          last_error?: string | null
          lease_expires_at?: string | null
          lease_token?: string | null
          next_attempt_at?: string
          object_path?: string
          queued_at?: string
        }
        Relationships: []
      }
      chat_attachment_maintenance: {
        Row: {
          lease_until: string | null
          run_id: string | null
          singleton: boolean
        }
        Insert: {
          lease_until?: string | null
          run_id?: string | null
          singleton?: boolean
        }
        Update: {
          lease_until?: string | null
          run_id?: string | null
          singleton?: boolean
        }
        Relationships: []
      }
      chat_attachment_objects: {
        Row: {
          byte_size: number
          chat_session_id: string
          created_at: string
          filename: string
          media_type: string
          object_path: string
          sha256: string
          user_id: string
        }
        Insert: {
          byte_size: number
          chat_session_id: string
          created_at?: string
          filename: string
          media_type: string
          object_path: string
          sha256: string
          user_id: string
        }
        Update: {
          byte_size?: number
          chat_session_id?: string
          created_at?: string
          filename?: string
          media_type?: string
          object_path?: string
          sha256?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_attachment_objects_chat_session_id_fkey"
            columns: ["chat_session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_sessions: {
        Row: {
          chat_title: string | null
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chat_title?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          chat_title?: string | null
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      message_parts: {
        Row: {
          chat_session_id: string
          created_at: string
          file_filename: string | null
          file_mediatype: string | null
          file_url: string | null
          id: string
          message_id: string
          order: number
          providermetadata: Json | null
          reasoning_state: string | null
          reasoning_text: string | null
          role: string
          source_document_filename: string | null
          source_document_id: string | null
          source_document_mediatype: string | null
          source_document_title: string | null
          source_url_id: string | null
          source_url_title: string | null
          source_url_url: string | null
          text_state: string | null
          text_text: string | null
          tool_searchuserdocument_approval: Json | null
          tool_searchuserdocument_errortext: string | null
          tool_searchuserdocument_input: Json | null
          tool_searchuserdocument_output: Json | null
          tool_searchuserdocument_providerexecuted: boolean | null
          tool_searchuserdocument_state: string | null
          tool_searchuserdocument_toolcallid: string | null
          tool_websitesearchtool_approval: Json | null
          tool_websitesearchtool_errortext: string | null
          tool_websitesearchtool_input: Json | null
          tool_websitesearchtool_output: Json | null
          tool_websitesearchtool_providerexecuted: boolean | null
          tool_websitesearchtool_state: string | null
          tool_websitesearchtool_toolcallid: string | null
          type: string
        }
        Insert: {
          chat_session_id: string
          created_at?: string
          file_filename?: string | null
          file_mediatype?: string | null
          file_url?: string | null
          id?: string
          message_id: string
          order?: number
          providermetadata?: Json | null
          reasoning_state?: string | null
          reasoning_text?: string | null
          role: string
          source_document_filename?: string | null
          source_document_id?: string | null
          source_document_mediatype?: string | null
          source_document_title?: string | null
          source_url_id?: string | null
          source_url_title?: string | null
          source_url_url?: string | null
          text_state?: string | null
          text_text?: string | null
          tool_searchuserdocument_approval?: Json | null
          tool_searchuserdocument_errortext?: string | null
          tool_searchuserdocument_input?: Json | null
          tool_searchuserdocument_output?: Json | null
          tool_searchuserdocument_providerexecuted?: boolean | null
          tool_searchuserdocument_state?: string | null
          tool_searchuserdocument_toolcallid?: string | null
          tool_websitesearchtool_approval?: Json | null
          tool_websitesearchtool_errortext?: string | null
          tool_websitesearchtool_input?: Json | null
          tool_websitesearchtool_output?: Json | null
          tool_websitesearchtool_providerexecuted?: boolean | null
          tool_websitesearchtool_state?: string | null
          tool_websitesearchtool_toolcallid?: string | null
          type: string
        }
        Update: {
          chat_session_id?: string
          created_at?: string
          file_filename?: string | null
          file_mediatype?: string | null
          file_url?: string | null
          id?: string
          message_id?: string
          order?: number
          providermetadata?: Json | null
          reasoning_state?: string | null
          reasoning_text?: string | null
          role?: string
          source_document_filename?: string | null
          source_document_id?: string | null
          source_document_mediatype?: string | null
          source_document_title?: string | null
          source_url_id?: string | null
          source_url_title?: string | null
          source_url_url?: string | null
          text_state?: string | null
          text_text?: string | null
          tool_searchuserdocument_approval?: Json | null
          tool_searchuserdocument_errortext?: string | null
          tool_searchuserdocument_input?: Json | null
          tool_searchuserdocument_output?: Json | null
          tool_searchuserdocument_providerexecuted?: boolean | null
          tool_searchuserdocument_state?: string | null
          tool_searchuserdocument_toolcallid?: string | null
          tool_websitesearchtool_approval?: Json | null
          tool_websitesearchtool_errortext?: string | null
          tool_websitesearchtool_input?: Json | null
          tool_websitesearchtool_output?: Json | null
          tool_websitesearchtool_providerexecuted?: boolean | null
          tool_websitesearchtool_state?: string | null
          tool_websitesearchtool_toolcallid?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_parts_chat_session_id_fkey"
            columns: ["chat_session_id"]
            isOneToOne: false
            referencedRelation: "chat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          created_at: string
          id: number
          name: string | null
          status: string
          stripe_current_period_end: string
          stripe_price_id: string
          stripe_subscription_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          name?: string | null
          status: string
          stripe_current_period_end: string
          stripe_price_id: string
          stripe_subscription_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: number
          name?: string | null
          status?: string
          stripe_current_period_end?: string
          stripe_price_id?: string
          stripe_subscription_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_documents: {
        Row: {
          ai_description: string | null
          ai_keyentities: string[] | null
          ai_maintopics: string[] | null
          ai_title: string | null
          created_at: string
          file_path: string
          id: string
          processing_error: string | null
          processing_job_id: string | null
          processing_status: string
          title: string
          total_pages: number
          updated_at: string | null
          user_id: string
        }
        Insert: {
          ai_description?: string | null
          ai_keyentities?: string[] | null
          ai_maintopics?: string[] | null
          ai_title?: string | null
          created_at?: string
          file_path: string
          id?: string
          processing_error?: string | null
          processing_job_id?: string | null
          processing_status?: string
          title: string
          total_pages: number
          updated_at?: string | null
          user_id: string
        }
        Update: {
          ai_description?: string | null
          ai_keyentities?: string[] | null
          ai_maintopics?: string[] | null
          ai_title?: string | null
          created_at?: string
          file_path?: string
          id?: string
          processing_error?: string | null
          processing_job_id?: string | null
          processing_status?: string
          title?: string
          total_pages?: number
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_documents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_documents_vec: {
        Row: {
          document_id: string
          embedding: string | null
          id: string
          page_number: number
          text_content: string
        }
        Insert: {
          document_id: string
          embedding?: string | null
          id?: string
          page_number: number
          text_content: string
        }
        Update: {
          document_id?: string
          embedding?: string | null
          id?: string
          page_number?: number
          text_content?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_documents_vec_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "user_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          email: string | null
          full_name: string | null
          id: string
          role: string
          stripe_customer_id: string | null
        }
        Insert: {
          email?: string | null
          full_name?: string | null
          id: string
          role?: string
          stripe_customer_id?: string | null
        }
        Update: {
          email?: string | null
          full_name?: string | null
          id?: string
          role?: string
          stripe_customer_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_chat_attachment_cleanup: {
        Args: { p_limit: number; p_token: string }
        Returns: {
          object_path: string
        }[]
      }
      claim_chat_attachment_maintenance: {
        Args: { p_previous_run_id?: string; p_run_id: string }
        Returns: boolean
      }
      complete_document_processing: {
        Args: {
          p_document_id: string
          p_expected_page_numbers: number[]
          p_job_id: string
          p_user_id: string
        }
        Returns: undefined
      }
      finish_chat_attachment_cleanup: {
        Args: { p_path: string; p_success: boolean; p_token: string }
        Returns: boolean
      }
      match_documents: {
        Args: {
          file_ids: string[]
          filter_user_id: string
          match_count: number
          query_embedding: string
          similarity_threshold?: number
        }
        Returns: {
          ai_description: string
          ai_keyentities: string[]
          ai_maintopics: string[]
          ai_title: string
          doc_timestamp: string
          id: string
          page_number: number
          similarity: number
          text_content: string
          title: string
          total_pages: number
        }[]
      }
      reserve_chat_attachment: {
        Args: {
          p_byte_size: number
          p_chat_id: string
          p_filename: string
          p_sha256: string
          p_user_id: string
        }
        Returns: {
          byte_size: number
          chat_session_id: string
          created_at: string
          filename: string
          media_type: string
          object_path: string
          sha256: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "chat_attachment_objects"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
